import { z } from "zod";
import type { Env } from "../env";
import { requireUser } from "../auth/session";
import { validateConfigInput } from "../domain/config";
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

export async function handleRooms(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
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
