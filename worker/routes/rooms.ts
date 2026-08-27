import { z } from "zod";
import type { Env } from "../env";
import { createGuestUserAndSession } from "../auth/passwordAuth";
import { GUEST_SESSION_TTL_MS, requireUser, sessionCookieHeader } from "../auth/session";
import { validateConfigInput } from "../domain/config";
import { writeAnalytics } from "../lib/analytics";
import { requireActiveMember } from "../lib/membership";
import { verifyTurnstile } from "../lib/turnstile";
import { coalesceJoinRequest } from "../lib/joinCoalesce";
import { errorJson, inviteCode, json, randomId, readJson } from "../lib/http";

const createRoomSchema = z.object({
  name: z.string().trim().min(2).max(48).default("Friends table"),
  smallBlind: z.number().int().positive(),
  startingStack: z.number().int().min(10).max(1000),
  potCapMultiplier: z.number().min(1).max(10).optional(),
});

const joinRequestSchema = z.object({
  inviteCode: z.string().trim().min(4).max(12),
  displayName: z.string().trim().min(2).max(32).optional(),
  idempotencyKey: z.string().min(8).max(80),
  turnstileToken: z.string().optional(),
});

const joinAsGuestSchema = z.object({
  inviteCode: z.string().trim().min(4).max(12),
  displayName: z.string().trim().min(2).max(32),
  turnstileToken: z.string().min(1).optional(),
  idempotencyKey: z.string().min(8).max(80),
});

/** Shared join-request create/coalesce (Turnstile already verified by caller). */
async function submitJoinRequest(
  env: Env,
  user: { id: string; displayName: string },
  data: {
    inviteCode: string;
    displayName?: string;
    idempotencyKey: string;
  },
): Promise<Response> {
  const existing = await env.DB.prepare(
    `SELECT response_json FROM idempotency_keys WHERE scope = ? AND key = ?`,
  )
    .bind(`join:${user.id}`, data.idempotencyKey)
    .first<{ response_json: string }>();
  if (existing) return json(JSON.parse(existing.response_json));

  const room = await env.DB.prepare(
    `SELECT * FROM rooms WHERE invite_code = ? AND status = 'open'`,
  )
    .bind(data.inviteCode.toUpperCase())
    .first<{
      id: string;
      host_user_id: string;
      name: string;
    }>();
  if (!room) return errorJson(404, "Table not found.");

  const member = await env.DB.prepare(
    `SELECT status FROM room_members WHERE room_id = ? AND user_id = ?`,
  )
    .bind(room.id, user.id)
    .first<{ status: string }>();

  const pendingExisting = await env.DB.prepare(
    `SELECT id FROM join_requests
     WHERE room_id = ? AND user_id = ? AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(room.id, user.id)
    .first<{ id: string }>();

  const requestId = randomId("jr");
  const coalesced = coalesceJoinRequest({
    memberStatus: member?.status,
    pendingRequestId: pendingExisting?.id,
    newRequestId: requestId,
  });
  const now = Date.now();
  const displayName = data.displayName ?? user.displayName;

  if (coalesced.status === "approved") {
    return json({ status: "approved", roomId: room.id, message: coalesced.message });
  }

  if (pendingExisting && coalesced.requestId === pendingExisting.id) {
    const payload = {
      status: "pending" as const,
      requestId: pendingExisting.id,
      roomId: room.id,
      message: coalesced.message,
    };
    await env.DB.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (scope, key, response_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(`join:${user.id}`, data.idempotencyKey, JSON.stringify(payload), now)
      .run();
    return json(payload);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO join_requests
       (id, room_id, user_id, display_name, status, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
      .bind(requestId, room.id, user.id, displayName, data.idempotencyKey, now)
      .run();
  } catch {
    return errorJson(409, "Duplicate join request.");
  }

  const stub = env.ROOM.get(env.ROOM.idFromName(room.id));
  await stub.fetch("https://room/join-request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId,
      userId: user.id,
      displayName,
    }),
  });

  const payload = {
    status: "pending",
    requestId,
    roomId: room.id,
    message: "Waiting for the host",
  };
  await env.DB.prepare(
    `INSERT INTO idempotency_keys (scope, key, response_json, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(`join:${user.id}`, data.idempotencyKey, JSON.stringify(payload), now)
    .run();
  return json(payload);
}

const decideSchema = z.object({
  requestId: z.string().min(1),
  approve: z.boolean(),
  seatIndex: z.number().int().min(0).max(9).optional().nullable(),
  asSpectator: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(80),
});

const updateConfigSchema = z.object({
  smallBlind: z.number().int().positive().optional(),
  startingStack: z.number().int().min(10).max(1000).optional(),
  potCapMultiplier: z.number().min(1).max(10).optional(),
  timeBankSeconds: z.number().int().min(0).max(600).optional(),
});

const rebuySchema = z.object({
  targetUserId: z.string().min(1).optional(),
  chips: z.number().int().min(10).max(1000).optional(),
});

const addBotsSchema = z.object({
  seatIndex: z.number().int().min(0).max(9).optional(),
  /** Seat a bot in every empty seat (ignores seatIndex). */
  fillOpen: z.boolean().optional(),
});

const kickSchema = z.object({
  targetUserId: z.string().min(1),
});

const awaySchema = z.object({
  away: z.boolean(),
});

const transferHostSchema = z.object({
  targetUserId: z.string().min(1),
});

const pauseSchema = z.object({
  paused: z.boolean(),
});

const seatPlayerSchema = z.object({
  targetUserId: z.string().min(1),
  seatIndex: z.number().int().min(0).max(9).optional(),
});

export async function handleRooms(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === "/api/rooms/mine" && request.method === "GET") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const rows = await env.DB.prepare(
      `SELECT r.id, r.name, r.invite_code, r.host_user_id, r.status, r.small_blind, r.big_blind,
              r.starting_stack, r.updated_at, m.role, m.seat_index, m.status AS member_status
       FROM room_members m
       JOIN rooms r ON r.id = m.room_id
       WHERE m.user_id = ? AND m.status IN ('seated', 'away', 'spectator')
       ORDER BY r.updated_at DESC
       LIMIT 50`,
    )
      .bind(auth.user.id)
      .all<{
        id: string;
        name: string;
        invite_code: string;
        host_user_id: string;
        status: string;
        small_blind: number;
        big_blind: number;
        starting_stack: number;
        updated_at: number;
        role: string;
        seat_index: number | null;
        member_status: string;
      }>();
    return json({
      rooms: (rows.results ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        inviteCode: r.invite_code,
        hostUserId: r.host_user_id,
        isHost: r.host_user_id === auth.user.id,
        status: r.status,
        smallBlind: r.small_blind,
        bigBlind: r.big_blind,
        startingStack: r.starting_stack,
        role: r.role,
        seatIndex: r.seat_index,
        memberStatus: r.member_status,
        updatedAt: r.updated_at,
      })),
    });
  }

  if (path === "/api/rooms" && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    if (auth.user.isGuest) {
      return errorJson(
        403,
        "Guests cannot create tables. Create a free account to host.",
      );
    }
    const parsed = await readJson(request, createRoomSchema);
    if (!parsed.ok) return parsed.response;
    const cfg = validateConfigInput(parsed.data);
    if (!cfg.ok) return errorJson(400, cfg.error);

    const roomId = randomId("room");
    const code = inviteCode();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO rooms
       (id, host_user_id, name, invite_code, small_blind, big_blind, starting_stack, pot_cap_multiplier, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
      .bind(
        roomId,
        auth.user.id,
        parsed.data.name,
        code,
        cfg.config.smallBlind,
        cfg.config.bigBlind,
        cfg.config.startingStack,
        cfg.config.potCapMultiplier,
        now,
        now,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO room_members
       (room_id, user_id, role, seat_index, display_name, status, created_at, updated_at)
       VALUES (?, ?, 'host', 0, ?, 'seated', ?, ?)`,
    )
      .bind(roomId, auth.user.id, auth.user.displayName, now, now)
      .run();

    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    await stub.fetch("https://room/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId,
        hostUserId: auth.user.id,
        hostDisplayName: auth.user.displayName,
        roomName: parsed.data.name,
        inviteCode: code,
        config: cfg.config,
      }),
    });

    writeAnalytics(env, "room_created", roomId);

    return json({
      room: {
        id: roomId,
        name: parsed.data.name,
        inviteCode: code,
        config: cfg.config,
      },
    });
  }

  if (path === "/api/rooms/join-as-guest" && request.method === "POST") {
    try {
      if (!env.SESSION_SECRET) {
        return errorJson(500, "SESSION_SECRET is not configured on this Worker.");
      }
      const ip = request.headers.get("cf-connecting-ip") ?? "anon";
      const limited = await env.JOIN_RATE_LIMIT.limit({ key: `guest-join:${ip}` });
      if (!limited.success) return errorJson(429, "Too many join requests.");

      const parsed = await readJson(request, joinAsGuestSchema);
      if (!parsed.ok) return parsed.response;

      // Verify Turnstile exactly once for the combined guest+join flow.
      const okTurnstile = await verifyTurnstile(
        env,
        parsed.data.turnstileToken,
        request.headers.get("cf-connecting-ip"),
      );
      if (!okTurnstile) return errorJson(403, "Turnstile verification failed.");

      const guest = await createGuestUserAndSession(env, parsed.data.displayName);
      const joinRes = await submitJoinRequest(
        env,
        {
          id: guest.userId,
          displayName: guest.displayName,
        },
        {
          inviteCode: parsed.data.inviteCode,
          displayName: guest.displayName,
          idempotencyKey: parsed.data.idempotencyKey,
        },
      );

      const joinBody = await joinRes.json();
      return new Response(
        JSON.stringify({
          user: {
            id: guest.userId,
            displayName: guest.displayName,
            username: null,
            isGuest: true,
          },
          join: joinBody,
          privacyNote:
            "Guest names are not accounts. Create a full account to host tables or keep your handle.",
        }),
        {
          status: joinRes.status >= 400 ? joinRes.status : 201,
          headers: {
            "content-type": "application/json",
            "set-cookie": sessionCookieHeader(
              guest.token,
              env.APP_ORIGIN,
              GUEST_SESSION_TTL_MS / 1000,
            ),
          },
        },
      );
    } catch (err) {
      console.error("join-as-guest failed", err instanceof Error ? err.message : err);
      return errorJson(500, "Guest join failed. Try again shortly.");
    }
  }

  if (path === "/api/rooms/join-request" && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const limited = await env.JOIN_RATE_LIMIT.limit({ key: auth.user.id });
    if (!limited.success) return errorJson(429, "Too many join requests.");

    const parsed = await readJson(request, joinRequestSchema);
    if (!parsed.ok) return parsed.response;

    const okTurnstile = await verifyTurnstile(
      env,
      parsed.data.turnstileToken,
      request.headers.get("cf-connecting-ip"),
    );
    if (!okTurnstile) return errorJson(403, "Turnstile verification failed.");

    return submitJoinRequest(env, auth.user, parsed.data);
  }

  if (path === "/api/rooms/join-decision" && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const parsed = await readJson(request, decideSchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const decisionScope = `join-decision:${auth.user.id}`;
    const cachedDecision = await env.DB.prepare(
      `SELECT response_json FROM idempotency_keys WHERE scope = ? AND key = ?`,
    )
      .bind(decisionScope, body.idempotencyKey)
      .first<{ response_json: string }>();
    if (cachedDecision) return json(JSON.parse(cachedDecision.response_json));

    const jr = await env.DB.prepare(`SELECT * FROM join_requests WHERE id = ?`)
      .bind(body.requestId)
      .first<{
        id: string;
        room_id: string;
        user_id: string;
        display_name: string;
        status: string;
      }>();
    if (!jr) return errorJson(404, "Join request not found.");
    const room = await env.DB.prepare(`SELECT host_user_id FROM rooms WHERE id = ?`)
      .bind(jr.room_id)
      .first<{ host_user_id: string }>();
    if (!room || room.host_user_id !== auth.user.id) {
      return errorJson(403, "Only the host can approve join requests.");
    }

    const now = Date.now();

    async function storeDecisionResponse(
      payload: Record<string, unknown>,
    ): Promise<Response> {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_keys (scope, key, response_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
        .bind(decisionScope, body.idempotencyKey, JSON.stringify(payload), now)
        .run();
      return json(payload);
    }

    if (jr.status !== "pending") {
      const settled =
        jr.status === "approved"
          ? {
              status: "approved" as const,
              message: "Join request was already approved.",
            }
          : {
              status: "rejected" as const,
              message: "Join request was already declined.",
            };
      return storeDecisionResponse(settled);
    }

    if (!body.approve) {
      await env.DB.prepare(
        `UPDATE join_requests SET status = 'rejected', decided_at = ? WHERE id = ?`,
      )
        .bind(now, jr.id)
        .run();
      const stub = env.ROOM.get(env.ROOM.idFromName(jr.room_id));
      await stub.fetch("https://room/reject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: jr.id, userId: jr.user_id }),
      });
      return storeDecisionResponse({
        status: "rejected",
        message: "Join request declined.",
      });
    }

    const asSpectator = body.asSpectator === true || body.seatIndex === null;

    const stub = env.ROOM.get(env.ROOM.idFromName(jr.room_id));
    const seatRes = await stub.fetch("https://room/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: jr.user_id,
        displayName: jr.display_name,
        seatIndex: asSpectator ? null : body.seatIndex,
        asSpectator,
        requestId: jr.id,
      }),
    });
    const seatBody = (await seatRes.json()) as {
      ok: boolean;
      seatIndex?: number;
      spectator?: boolean;
      error?: string;
    };
    if (!seatBody.ok) return errorJson(409, seatBody.error ?? "This table is full.");

    const memberStatus = seatBody.spectator ? "spectator" : "seated";
    const memberRole = "player";

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE join_requests SET status = 'approved', decided_at = ? WHERE id = ?`,
      ).bind(now, jr.id),
      // Collapse any duplicate pending rows for the same user (pre-fix clients).
      env.DB.prepare(
        `UPDATE join_requests SET status = 'rejected', decided_at = ?
         WHERE room_id = ? AND user_id = ? AND status = 'pending' AND id != ?`,
      ).bind(now, jr.room_id, jr.user_id, jr.id),
      env.DB.prepare(
        `INSERT INTO room_members
         (room_id, user_id, role, seat_index, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id, user_id) DO UPDATE SET
           status = excluded.status, seat_index = excluded.seat_index,
           display_name = excluded.display_name, updated_at = excluded.updated_at`,
      ).bind(
        jr.room_id,
        jr.user_id,
        memberRole,
        seatBody.spectator ? null : (seatBody.seatIndex ?? 0),
        jr.display_name,
        memberStatus,
        now,
        now,
      ),
    ]);

    // Drop any duplicate pending cards for this user from the live room view.
    const dupes = await env.DB.prepare(
      `SELECT id FROM join_requests
       WHERE room_id = ? AND user_id = ? AND status = 'rejected' AND decided_at = ? AND id != ?`,
    )
      .bind(jr.room_id, jr.user_id, now, jr.id)
      .all<{ id: string }>();
    for (const row of dupes.results ?? []) {
      await stub.fetch("https://room/reject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: row.id, userId: jr.user_id }),
      });
    }

    return storeDecisionResponse({
      status: "approved",
      seatIndex: seatBody.spectator ? null : seatBody.seatIndex,
      spectator: Boolean(seatBody.spectator),
      message: seatBody.spectator ? "You can watch this table." : "You have a seat",
    });
  }

  const leaveMatch = path.match(/^\/api\/rooms\/([^/]+)\/leave$/);
  if (leaveMatch && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = leaveMatch[1]!;
    const member = await env.DB.prepare(
      `SELECT role FROM room_members WHERE room_id = ? AND user_id = ?`,
    )
      .bind(roomId, auth.user.id)
      .first<{ role: string }>();
    if (!member) return errorJson(404, "You are not at this table.");
    if (member.role === "host") {
      return errorJson(
        400,
        "Host cannot leave while hosting. Transfer host or close the table.",
      );
    }

    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const doRes = await stub.fetch("https://room/leave", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: auth.user.id }),
    });
    const doBody = (await doRes.json()) as { ok: boolean; error?: string };
    if (!doBody.ok) return errorJson(400, doBody.error ?? "Could not leave.");

    const now = Date.now();
    await env.DB.prepare(
      `UPDATE room_members SET status = 'left', seat_index = NULL, updated_at = ?
       WHERE room_id = ? AND user_id = ?`,
    )
      .bind(now, roomId, auth.user.id)
      .run();

    return json({ status: "left", message: "You left the table." });
  }

  const kickMatch = path.match(/^\/api\/rooms\/([^/]+)\/kick$/);
  if (kickMatch && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = kickMatch[1]!;
    const parsed = await readJson(request, kickSchema);
    if (!parsed.ok) return parsed.response;

    const room = await env.DB.prepare(`SELECT host_user_id FROM rooms WHERE id = ?`)
      .bind(roomId)
      .first<{ host_user_id: string }>();
    if (!room) return errorJson(404, "Table not found.");
    if (room.host_user_id !== auth.user.id) {
      return errorJson(403, "Only the host can kick players.");
    }

    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const doRes = await stub.fetch("https://room/kick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostUserId: auth.user.id,
        targetUserId: parsed.data.targetUserId,
      }),
    });
    const doBody = (await doRes.json()) as { ok: boolean; error?: string };
    if (!doBody.ok) return errorJson(400, doBody.error ?? "Could not kick player.");

    const now = Date.now();
    await env.DB.prepare(
      `UPDATE room_members SET status = 'kicked', seat_index = NULL, updated_at = ?
       WHERE room_id = ? AND user_id = ?`,
    )
      .bind(now, roomId, parsed.data.targetUserId)
      .run();

    return json({ status: "kicked", message: "Player removed from the table." });
  }

  const rebuyMatch = path.match(/^\/api\/rooms\/([^/]+)\/rebuy$/);
  if (rebuyMatch && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = rebuyMatch[1]!;
    const parsed = await readJson(request, rebuySchema);
    if (!parsed.ok) return parsed.response;

    const member = await env.DB.prepare(
      `SELECT role FROM room_members WHERE room_id = ? AND user_id = ? AND status = 'seated'`,
    )
      .bind(roomId, auth.user.id)
      .first<{ role: string }>();
    if (!member) return errorJson(403, "You need a seat at this table.");

    const targetUserId = parsed.data.targetUserId ?? auth.user.id;
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const doRes = await stub.fetch("https://room/rebuy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requesterId: auth.user.id,
        targetUserId,
        chips: parsed.data.chips,
      }),
    });
    const doBody = (await doRes.json()) as { ok: boolean; error?: string };
    if (!doBody.ok) return errorJson(400, doBody.error ?? "Could not rebuy.");
    return json({ status: "ok", message: "Stack reset with play-money chips." });
  }

  const awayMatch = path.match(/^\/api\/rooms\/([^/]+)\/away$/);
  if (awayMatch && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = awayMatch[1]!;
    const parsed = await readJson(request, awaySchema);
    if (!parsed.ok) return parsed.response;

    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const doRes = await stub.fetch("https://room/away", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: auth.user.id, away: parsed.data.away }),
    });
    const doBody = (await doRes.json()) as { ok: boolean; error?: string };
    if (!doBody.ok) return errorJson(400, doBody.error ?? "Could not update presence.");

    const now = Date.now();
    await env.DB.prepare(
      `UPDATE room_members SET status = ?, updated_at = ?
       WHERE room_id = ? AND user_id = ?`,
    )
      .bind(parsed.data.away ? "away" : "seated", now, roomId, auth.user.id)
      .run();

    return json({
      status: parsed.data.away ? "away" : "seated",
      message: parsed.data.away ? "Marked away." : "Back at the table.",
    });
  }

  const pauseMatch = path.match(/^\/api\/rooms\/([^/]+)\/pause$/);
  if (pauseMatch && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = pauseMatch[1]!;
    const parsed = await readJson(request, pauseSchema);
    if (!parsed.ok) return parsed.response;
    const room = await env.DB.prepare(`SELECT host_user_id FROM rooms WHERE id = ?`)
      .bind(roomId)
      .first<{ host_user_id: string }>();
    if (!room) return errorJson(404, "Table not found.");
    if (room.host_user_id !== auth.user.id) {
      return errorJson(403, "Only the host can pause.");
    }
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const doRes = await stub.fetch("https://room/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostUserId: auth.user.id, paused: parsed.data.paused }),
    });
    const doBody = (await doRes.json()) as {
      ok: boolean;
      paused?: boolean;
      error?: string;
    };
    if (!doBody.ok) return errorJson(400, doBody.error ?? "Could not pause.");
    return json({
      status: "ok",
      paused: Boolean(doBody.paused),
      message: doBody.paused ? "Table paused." : "Table resumed.",
    });
  }

  const transferMatch = path.match(/^\/api\/rooms\/([^/]+)\/transfer-host$/);
  if (transferMatch && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    if (auth.user.isGuest) {
      return errorJson(403, "Guests cannot transfer host. Create an account first.");
    }
    const roomId = transferMatch[1]!;
    const parsed = await readJson(request, transferHostSchema);
    if (!parsed.ok) return parsed.response;
    const room = await env.DB.prepare(`SELECT host_user_id FROM rooms WHERE id = ?`)
      .bind(roomId)
      .first<{ host_user_id: string }>();
    if (!room) return errorJson(404, "Table not found.");
    if (room.host_user_id !== auth.user.id) {
      return errorJson(403, "Only the host can transfer.");
    }

    const target = await env.DB.prepare(
      `SELECT u.id, u.display_name, u.is_guest, m.status
       FROM room_members m JOIN users u ON u.id = m.user_id
       WHERE m.room_id = ? AND m.user_id = ? AND m.status IN ('seated', 'away', 'spectator')`,
    )
      .bind(roomId, parsed.data.targetUserId)
      .first<{
        id: string;
        display_name: string;
        is_guest: number | null;
        status: string;
      }>();
    if (!target) return errorJson(404, "That player is not at this table.");
    if (target.is_guest) {
      return errorJson(400, "Host can only transfer to a registered account.");
    }

    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const doRes = await stub.fetch("https://room/transfer-host", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hostUserId: auth.user.id,
        targetUserId: target.id,
        targetDisplayName: target.display_name,
      }),
    });
    const doBody = (await doRes.json()) as { ok: boolean; error?: string };
    if (!doBody.ok) return errorJson(400, doBody.error ?? "Could not transfer host.");

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE rooms SET host_user_id = ?, updated_at = ? WHERE id = ?`,
      ).bind(target.id, now, roomId),
      env.DB.prepare(
        `UPDATE room_members SET role = 'player', updated_at = ? WHERE room_id = ? AND user_id = ?`,
      ).bind(now, roomId, auth.user.id),
      env.DB.prepare(
        `UPDATE room_members SET role = 'host', updated_at = ? WHERE room_id = ? AND user_id = ?`,
      ).bind(now, roomId, target.id),
    ]);

    return json({
      status: "ok",
      hostUserId: target.id,
      message: `${target.display_name} is now the host.`,
    });
  }

  const closeMatch = path.match(/^\/api\/rooms\/([^/]+)\/close$/);
  if (closeMatch && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = closeMatch[1]!;
    const room = await env.DB.prepare(`SELECT host_user_id FROM rooms WHERE id = ?`)
      .bind(roomId)
      .first<{ host_user_id: string }>();
    if (!room) return errorJson(404, "Table not found.");
    if (room.host_user_id !== auth.user.id) {
      return errorJson(403, "Only the host can close the table.");
    }

    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const doRes = await stub.fetch("https://room/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostUserId: auth.user.id }),
    });
    const doBody = (await doRes.json()) as { ok: boolean; error?: string; code?: string };
    if (!doBody.ok) {
      const status =
        doRes.status === 409 || doBody.code === "hand_in_progress" ? 409 : 400;
      return errorJson(status, doBody.error ?? "Could not close table.");
    }

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE rooms SET status = 'closed', updated_at = ? WHERE id = ?`,
      ).bind(now, roomId),
      env.DB.prepare(
        `UPDATE room_members SET status = 'left', seat_index = NULL, updated_at = ?
         WHERE room_id = ? AND status IN ('seated', 'away', 'spectator')`,
      ).bind(now, roomId),
    ]);

    return json({ status: "closed", message: "Table closed." });
  }

  const ledgerMatch = path.match(/^\/api\/rooms\/([^/]+)\/ledger$/);
  if (ledgerMatch && (request.method === "GET" || request.method === "POST")) {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = ledgerMatch[1]!;
    const member = await requireActiveMember(env, roomId, auth.user.id);
    if (!member.ok) return errorJson(403, "Ask to join this table first.");

    const url = new URL(request.url);
    const format = url.searchParams.get("format");
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const doUrl =
      format === "csv" ? "https://room/ledger?format=csv" : "https://room/ledger";
    const doRes = await stub.fetch(doUrl);
    if (format === "csv") {
      const text = await doRes.text();
      return new Response(text, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="ledger-${roomId}.csv"`,
        },
      });
    }
    const doBody = (await doRes.json()) as {
      ok: boolean;
      ledger?: unknown;
      error?: string;
    };
    if (!doBody.ok) return errorJson(400, doBody.error ?? "Could not load ledger.");
    return json({ ledger: doBody.ledger });
  }

  const seatMatch = path.match(/^\/api\/rooms\/([^/]+)\/seat$/);
  if (seatMatch && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = seatMatch[1]!;
    const parsed = await readJson(request, seatPlayerSchema);
    if (!parsed.ok) return parsed.response;
    const room = await env.DB.prepare(`SELECT host_user_id FROM rooms WHERE id = ?`)
      .bind(roomId)
      .first<{ host_user_id: string }>();
    if (!room) return errorJson(404, "Table not found.");
    // Host-only: spectators / kicked / left must not self-seat for chips.
    if (room.host_user_id !== auth.user.id) {
      return errorJson(403, "Only the host can seat a player.");
    }
    const target = await env.DB.prepare(
      `SELECT user_id, display_name, status FROM room_members WHERE room_id = ? AND user_id = ?`,
    )
      .bind(roomId, parsed.data.targetUserId)
      .first<{ user_id: string; display_name: string; status: string }>();
    if (!target) return errorJson(404, "Player not at this table.");
    if (target.status === "kicked" || target.status === "left") {
      return errorJson(
        403,
        "That player left or was removed. They must ask to join again.",
      );
    }
    if (
      target.status !== "spectator" &&
      target.status !== "seated" &&
      target.status !== "away"
    ) {
      return errorJson(403, "That player cannot be seated from their current status.");
    }

    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const doRes = await stub.fetch("https://room/seat-spectator", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: target.user_id,
        displayName: target.display_name,
        seatIndex: parsed.data.seatIndex,
      }),
    });
    const doBody = (await doRes.json()) as {
      ok: boolean;
      seatIndex?: number;
      error?: string;
    };
    if (!doBody.ok) return errorJson(409, doBody.error ?? "Could not seat player.");

    const now = Date.now();
    await env.DB.prepare(
      `UPDATE room_members SET status = 'seated', seat_index = ?, updated_at = ?
       WHERE room_id = ? AND user_id = ?`,
    )
      .bind(doBody.seatIndex ?? 0, now, roomId, target.user_id)
      .run();

    return json({ status: "seated", seatIndex: doBody.seatIndex, message: "Seated." });
  }

  const botsMatch = path.match(/^\/api\/rooms\/([^/]+)\/bots$/);
  if (botsMatch && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = botsMatch[1]!;
    const parsed = await readJson(request, addBotsSchema);
    if (!parsed.ok) return parsed.response;

    const room = await env.DB.prepare(`SELECT host_user_id FROM rooms WHERE id = ?`)
      .bind(roomId)
      .first<{ host_user_id: string }>();
    if (!room) return errorJson(404, "Table not found.");
    if (room.host_user_id !== auth.user.id) {
      return errorJson(403, "Only the host can add bots.");
    }

    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const openRes = await stub.fetch("https://room/open-seats");
    const openBody = (await openRes.json()) as {
      ok?: boolean;
      openSeats?: number[];
      error?: string;
    };
    if (!openBody.ok || !openBody.openSeats) {
      return errorJson(400, openBody.error ?? "Could not read open seats.");
    }

    let targets: number[];
    if (parsed.data.fillOpen) {
      targets = openBody.openSeats;
    } else if (parsed.data.seatIndex !== undefined) {
      if (!openBody.openSeats.includes(parsed.data.seatIndex)) {
        return errorJson(409, "That seat is taken.");
      }
      targets = [parsed.data.seatIndex];
    } else if (openBody.openSeats.length > 0) {
      targets = [openBody.openSeats[0]!];
    } else {
      return errorJson(409, "This table is full.");
    }

    if (targets.length === 0) {
      return errorJson(409, "No open seats to fill.");
    }

    const seated: Array<{ botUserId: string; displayName: string; seatIndex: number }> =
      [];
    const now = Date.now();

    for (const seatIndex of targets) {
      const botUserId = randomId("bot");
      const doRes = await stub.fetch("https://room/seat-bot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botUserId, seatIndex }),
      });
      const doBody = (await doRes.json()) as {
        ok: boolean;
        seatIndex?: number;
        displayName?: string;
        botUserId?: string;
        error?: string;
      };
      if (!doBody.ok || doBody.seatIndex === undefined || !doBody.displayName) {
        if (seated.length === 0) {
          return errorJson(409, doBody.error ?? "Could not seat bot.");
        }
        break;
      }

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO users (id, display_name, username, email, password_hash, is_guest, created_at, updated_at)
           VALUES (?, ?, NULL, NULL, NULL, 1, ?, ?)`,
        ).bind(botUserId, doBody.displayName, now, now),
        env.DB.prepare(
          `INSERT INTO room_members
           (room_id, user_id, role, seat_index, display_name, status, created_at, updated_at)
           VALUES (?, ?, 'player', ?, ?, 'seated', ?, ?)
           ON CONFLICT(room_id, user_id) DO UPDATE SET
             status = 'seated', seat_index = excluded.seat_index,
             display_name = excluded.display_name, updated_at = excluded.updated_at`,
        ).bind(roomId, botUserId, doBody.seatIndex, doBody.displayName, now, now),
      ]);

      seated.push({
        botUserId,
        displayName: doBody.displayName,
        seatIndex: doBody.seatIndex,
      });
      writeAnalytics(
        env,
        "bot_seated",
        roomId,
        [doBody.seatIndex],
        [botUserId.slice(0, 8)],
      );
    }

    return json({
      status: "ok",
      bots: seated,
      message:
        seated.length === 1
          ? `${seated[0]!.displayName} took an open seat.`
          : `Seated ${seated.length} bots in open seats.`,
    });
  }

  const handsMatch = path.match(/^\/api\/rooms\/([^/]+)\/hands$/);
  if (handsMatch && request.method === "GET") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = handsMatch[1]!;
    const member = await requireActiveMember(env, roomId, auth.user.id);
    if (!member.ok) return errorJson(403, "Ask to join this table first.");

    const rows = await env.DB.prepare(
      `SELECT id, hand_number, summary_json, created_at
       FROM hand_summaries WHERE room_id = ?
       ORDER BY hand_number DESC LIMIT 50`,
    )
      .bind(roomId)
      .all<{
        id: string;
        hand_number: number;
        summary_json: string;
        created_at: number;
      }>();

    return json({
      hands: (rows.results ?? []).map((h) => {
        let summary: unknown = {};
        try {
          summary = JSON.parse(h.summary_json);
        } catch {
          summary = {};
        }
        return {
          id: h.id,
          handNumber: h.hand_number,
          createdAt: h.created_at,
          summary,
        };
      }),
    });
  }

  const handMatch = path.match(/^\/api\/rooms\/([^/]+)\/hands\/(\d+)$/);
  if (handMatch && request.method === "GET") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = handMatch[1]!;
    const handNumber = Number(handMatch[2]);
    const member = await requireActiveMember(env, roomId, auth.user.id);
    if (!member.ok) return errorJson(403, "Ask to join this table first.");

    const row = await env.DB.prepare(
      `SELECT id, hand_number, summary_json, created_at
       FROM hand_summaries WHERE room_id = ? AND hand_number = ?`,
    )
      .bind(roomId, handNumber)
      .first<{
        id: string;
        hand_number: number;
        summary_json: string;
        created_at: number;
      }>();

    let summary: unknown = null;
    const r2Key = `replays/${roomId}/hand-${handNumber}.json`;
    try {
      const obj = await env.REPLAY_R2.get(r2Key);
      if (obj) summary = JSON.parse(await obj.text());
    } catch {
      /* fall through to D1 */
    }
    if (summary == null && row) {
      try {
        summary = JSON.parse(row.summary_json);
      } catch {
        summary = {};
      }
    }
    if (summary == null) return errorJson(404, "Hand not found.");

    return json({
      roomId,
      handNumber,
      createdAt: row?.created_at ?? null,
      summary,
      source: row ? "d1+r2" : "r2",
    });
  }

  const openSeatsMatch = path.match(/^\/api\/rooms\/([^/]+)\/open-seats$/);
  if (openSeatsMatch && request.method === "GET") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = openSeatsMatch[1]!;
    const room = await env.DB.prepare(`SELECT host_user_id FROM rooms WHERE id = ?`)
      .bind(roomId)
      .first<{ host_user_id: string }>();
    if (!room) return errorJson(404, "Table not found.");
    if (room.host_user_id !== auth.user.id) {
      return errorJson(403, "Only the host can view open seats for approve.");
    }
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const doRes = await stub.fetch("https://room/open-seats");
    const doBody = (await doRes.json()) as {
      ok: boolean;
      openSeats?: number[];
      error?: string;
    };
    if (!doBody.ok) return errorJson(400, doBody.error ?? "Could not load seats.");
    return json({ openSeats: doBody.openSeats ?? [] });
  }

  const configMatch = path.match(/^\/api\/rooms\/([^/]+)\/config$/);
  if (configMatch && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = configMatch[1]!;
    const parsed = await readJson(request, updateConfigSchema);
    if (!parsed.ok) return parsed.response;
    const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`)
      .bind(roomId)
      .first<{
        host_user_id: string;
        small_blind: number;
        starting_stack: number;
        pot_cap_multiplier: number;
      }>();
    if (!room) return errorJson(404, "Table not found.");
    if (room.host_user_id !== auth.user.id) {
      return errorJson(403, "Only the host can change table rules.");
    }
    const nextSmall = parsed.data.smallBlind ?? room.small_blind;
    const nextStack = parsed.data.startingStack ?? room.starting_stack;
    const nextCap = parsed.data.potCapMultiplier ?? room.pot_cap_multiplier;
    const cfg = validateConfigInput({
      smallBlind: nextSmall,
      startingStack: nextStack,
      potCapMultiplier: nextCap,
      timeBankSeconds: parsed.data.timeBankSeconds,
    });
    if (!cfg.ok) return errorJson(400, cfg.error);

    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    const doRes = await stub.fetch("https://room/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        smallBlind: parsed.data.smallBlind,
        startingStack: parsed.data.startingStack,
        potCapMultiplier: parsed.data.potCapMultiplier,
        timeBankSeconds: parsed.data.timeBankSeconds,
      }),
    });
    const doBody = (await doRes.json()) as {
      ok: boolean;
      error?: string;
      pending?: boolean;
    };
    if (!doBody.ok) return errorJson(400, doBody.error ?? "Could not update rules.");

    await env.DB.prepare(
      `UPDATE rooms SET small_blind = ?, big_blind = ?, starting_stack = ?, pot_cap_multiplier = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        cfg.config.smallBlind,
        cfg.config.bigBlind,
        cfg.config.startingStack,
        cfg.config.potCapMultiplier,
        Date.now(),
        roomId,
      )
      .run();

    return json({
      status: "ok",
      pending: Boolean(doBody.pending),
      config: cfg.config,
      message: doBody.pending
        ? "Rules update after the next hand starts."
        : "Table rules updated.",
    });
  }

  const roomMatch = path.match(/^\/api\/rooms\/([^/]+)$/);
  if (roomMatch && request.method === "GET") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = roomMatch[1]!;
    const room = await env.DB.prepare(
      `SELECT id, host_user_id, name, invite_code, small_blind, big_blind, starting_stack, pot_cap_multiplier, status
       FROM rooms WHERE id = ?`,
    )
      .bind(roomId)
      .first<{
        id: string;
        host_user_id: string;
        name: string;
        invite_code: string;
        small_blind: number;
        big_blind: number;
        starting_stack: number;
        pot_cap_multiplier: number;
        status: string;
      }>();
    if (!room) return errorJson(404, "Table not found.");

    const member = await env.DB.prepare(
      `SELECT role, seat_index, display_name, status FROM room_members WHERE room_id = ? AND user_id = ?`,
    )
      .bind(roomId, auth.user.id)
      .first<{
        role: string;
        seat_index: number | null;
        display_name: string;
        status: string;
      }>();

    // Kicked / left rows must not retain invite codes or table access.
    if (
      member &&
      (member.status === "seated" ||
        member.status === "away" ||
        member.status === "spectator")
    ) {
      return json({
        access: "member",
        room: {
          id: room.id,
          name: room.name,
          inviteCode: room.invite_code,
          hostUserId: room.host_user_id,
          smallBlind: room.small_blind,
          bigBlind: room.big_blind,
          startingStack: room.starting_stack,
          potCapMultiplier: room.pot_cap_multiplier,
          status: room.status,
        },
        member,
      });
    }

    const pending = await env.DB.prepare(
      `SELECT id, status FROM join_requests
       WHERE room_id = ? AND user_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(roomId, auth.user.id)
      .first<{ id: string; status: string }>();

    if (pending) {
      return json({
        access: "pending",
        room: {
          id: room.id,
          name: room.name,
          inviteCode: room.invite_code,
          hostUserId: room.host_user_id,
          smallBlind: room.small_blind,
          bigBlind: room.big_blind,
        },
        requestId: pending.id,
        message: "Waiting for the host",
      });
    }

    const rejected = await env.DB.prepare(
      `SELECT id FROM join_requests
       WHERE room_id = ? AND user_id = ? AND status = 'rejected'
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(roomId, auth.user.id)
      .first();
    if (rejected) {
      return json({
        access: "rejected",
        room: { id: room.id, name: room.name },
        message: "The host declined this join request.",
      });
    }

    return errorJson(403, "Ask to join this table first.");
  }

  return null;
}
