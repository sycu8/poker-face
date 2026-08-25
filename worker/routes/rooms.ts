import { z } from "zod";
import type { Env } from "../env";
import { requireUser } from "../auth/session";
import { validateConfigInput } from "../domain/config";
import { writeAnalytics } from "../lib/analytics";
import { verifyTurnstile } from "../lib/turnstile";
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

const decideSchema = z.object({
  requestId: z.string().min(1),
  approve: z.boolean(),
  seatIndex: z.number().int().min(0).max(8).optional(),
  idempotencyKey: z.string().min(8).max(80),
});

const updateConfigSchema = z.object({
  smallBlind: z.number().int().positive().optional(),
  startingStack: z.number().int().min(10).max(1000).optional(),
  potCapMultiplier: z.number().min(1).max(10).optional(),
});

const rebuySchema = z.object({
  targetUserId: z.string().min(1).optional(),
  chips: z.number().int().min(10).max(1000).optional(),
});

const kickSchema = z.object({
  targetUserId: z.string().min(1),
});

const awaySchema = z.object({
  away: z.boolean(),
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
       WHERE m.user_id = ? AND m.status IN ('seated', 'away')
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

    const existing = await env.DB.prepare(
      `SELECT response_json FROM idempotency_keys WHERE scope = ? AND key = ?`,
    )
      .bind(`join:${auth.user.id}`, parsed.data.idempotencyKey)
      .first<{ response_json: string }>();
    if (existing) return json(JSON.parse(existing.response_json));

    const room = await env.DB.prepare(
      `SELECT * FROM rooms WHERE invite_code = ? AND status = 'open'`,
    )
      .bind(parsed.data.inviteCode.toUpperCase())
      .first<{
        id: string;
        host_user_id: string;
        name: string;
      }>();
    if (!room) return errorJson(404, "Table not found.");

    const member = await env.DB.prepare(
      `SELECT status FROM room_members WHERE room_id = ? AND user_id = ?`,
    )
      .bind(room.id, auth.user.id)
      .first<{ status: string }>();
    if (member?.status === "seated") {
      const payload = { status: "approved", roomId: room.id, message: "You have a seat" };
      return json(payload);
    }

    const requestId = randomId("jr");
    const now = Date.now();
    const displayName = parsed.data.displayName ?? auth.user.displayName;
    try {
      await env.DB.prepare(
        `INSERT INTO join_requests
         (id, room_id, user_id, display_name, status, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
        .bind(requestId, room.id, auth.user.id, displayName, parsed.data.idempotencyKey, now)
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
        userId: auth.user.id,
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
      .bind(`join:${auth.user.id}`, parsed.data.idempotencyKey, JSON.stringify(payload), now)
      .run();
    return json(payload);
  }

  if (path === "/api/rooms/join-decision" && request.method === "POST") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const parsed = await readJson(request, decideSchema);
    if (!parsed.ok) return parsed.response;

    const jr = await env.DB.prepare(`SELECT * FROM join_requests WHERE id = ?`)
      .bind(parsed.data.requestId)
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
    if (!parsed.data.approve) {
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
      return json({ status: "rejected", message: "Join request declined." });
    }

    const stub = env.ROOM.get(env.ROOM.idFromName(jr.room_id));
    const seatRes = await stub.fetch("https://room/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: jr.user_id,
        displayName: jr.display_name,
        seatIndex: parsed.data.seatIndex,
        requestId: jr.id,
      }),
    });
    const seatBody = (await seatRes.json()) as { ok: boolean; seatIndex?: number; error?: string };
    if (!seatBody.ok) return errorJson(409, seatBody.error ?? "This table is full.");

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE join_requests SET status = 'approved', decided_at = ? WHERE id = ?`,
      ).bind(now, jr.id),
      env.DB.prepare(
        `INSERT INTO room_members
         (room_id, user_id, role, seat_index, display_name, status, created_at, updated_at)
         VALUES (?, ?, 'player', ?, ?, 'seated', ?, ?)
         ON CONFLICT(room_id, user_id) DO UPDATE SET
           status = 'seated', seat_index = excluded.seat_index, updated_at = excluded.updated_at`,
      ).bind(
        jr.room_id,
        jr.user_id,
        seatBody.seatIndex ?? 0,
        jr.display_name,
        now,
        now,
      ),
    ]);

    return json({
      status: "approved",
      seatIndex: seatBody.seatIndex,
      message: "You have a seat",
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
      return errorJson(400, "Host cannot leave while hosting. Close the table instead.");
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

  const handsMatch = path.match(/^\/api\/rooms\/([^/]+)\/hands$/);
  if (handsMatch && request.method === "GET") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    const roomId = handsMatch[1]!;
    const member = await env.DB.prepare(
      `SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?`,
    )
      .bind(roomId, auth.user.id)
      .first();
    if (!member) return errorJson(403, "Ask to join this table first.");

    const rows = await env.DB.prepare(
      `SELECT id, hand_number, summary_json, created_at
       FROM hand_summaries WHERE room_id = ?
       ORDER BY hand_number DESC LIMIT 50`,
    )
      .bind(roomId)
      .all<{ id: string; hand_number: number; summary_json: string; created_at: number }>();

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
    const member = await env.DB.prepare(
      `SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?`,
    )
      .bind(roomId, auth.user.id)
      .first();
    if (!member) return errorJson(403, "Ask to join this table first.");

    const row = await env.DB.prepare(
      `SELECT id, hand_number, summary_json, created_at
       FROM hand_summaries WHERE room_id = ? AND hand_number = ?`,
    )
      .bind(roomId, handNumber)
      .first<{ id: string; hand_number: number; summary_json: string; created_at: number }>();

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
    const doBody = (await doRes.json()) as { ok: boolean; openSeats?: number[]; error?: string };
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
      }),
    });
    const doBody = (await doRes.json()) as { ok: boolean; error?: string; pending?: boolean };
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

    if (member) {
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
