import type { Env } from "../env";
import { randomId } from "./http";

export type MembershipOp = "leave" | "kick" | "seat" | "spectator" | "reject_request";

export interface MembershipOpPayload {
  displayName?: string;
  seatIndex?: number | null;
  requestId?: string;
  status?: string;
  role?: string;
}

/** Enqueue a D1 membership write for later flush after DO already succeeded. */
export async function enqueueMembershipOp(
  env: Env,
  roomId: string,
  userId: string,
  op: MembershipOp,
  payload: MembershipOpPayload = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO membership_ops (id, room_id, user_id, op, payload_json, created_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(randomId("mop"), roomId, userId, op, JSON.stringify(payload), Date.now())
    .run();
}

async function applyMembershipOp(
  env: Env,
  roomId: string,
  userId: string,
  op: MembershipOp,
  payload: MembershipOpPayload,
): Promise<void> {
  const now = Date.now();
  switch (op) {
    case "leave":
      await env.DB.prepare(
        `UPDATE room_members SET status = 'left', seat_index = NULL, updated_at = ?
         WHERE room_id = ? AND user_id = ?`,
      )
        .bind(now, roomId, userId)
        .run();
      return;
    case "kick":
      await env.DB.prepare(
        `UPDATE room_members SET status = 'kicked', seat_index = NULL, updated_at = ?
         WHERE room_id = ? AND user_id = ?`,
      )
        .bind(now, roomId, userId)
        .run();
      return;
    case "seat":
      await env.DB.prepare(
        `INSERT INTO room_members
         (room_id, user_id, role, seat_index, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'seated', ?, ?)
         ON CONFLICT(room_id, user_id) DO UPDATE SET
           status = 'seated', seat_index = excluded.seat_index,
           display_name = excluded.display_name, updated_at = excluded.updated_at`,
      )
        .bind(
          roomId,
          userId,
          payload.role ?? "player",
          payload.seatIndex ?? 0,
          payload.displayName ?? "Player",
          now,
          now,
        )
        .run();
      if (payload.requestId) {
        await env.DB.prepare(
          `UPDATE join_requests SET status = 'approved', decided_at = ? WHERE id = ?`,
        )
          .bind(now, payload.requestId)
          .run();
      }
      return;
    case "spectator":
      await env.DB.prepare(
        `INSERT INTO room_members
         (room_id, user_id, role, seat_index, display_name, status, created_at, updated_at)
         VALUES (?, ?, 'player', NULL, ?, 'spectator', ?, ?)
         ON CONFLICT(room_id, user_id) DO UPDATE SET
           status = 'spectator', seat_index = NULL,
           display_name = excluded.display_name, updated_at = excluded.updated_at`,
      )
        .bind(roomId, userId, payload.displayName ?? "Player", now, now)
        .run();
      if (payload.requestId) {
        await env.DB.prepare(
          `UPDATE join_requests SET status = 'approved', decided_at = ? WHERE id = ?`,
        )
          .bind(now, payload.requestId)
          .run();
      }
      return;
    case "reject_request":
      if (payload.requestId) {
        await env.DB.prepare(
          `UPDATE join_requests SET status = 'rejected', decided_at = ? WHERE id = ?`,
        )
          .bind(now, payload.requestId)
          .run();
      }
      return;
    default:
      return;
  }
}

/** Apply pending membership ops for a room (or all rooms when roomId omitted). */
export async function flushMembershipOps(
  env: Env,
  roomId?: string,
  limit = 32,
): Promise<number> {
  const rows = roomId
    ? await env.DB.prepare(
        `SELECT id, room_id, user_id, op, payload_json, attempts FROM membership_ops
         WHERE room_id = ? ORDER BY created_at ASC LIMIT ?`,
      )
        .bind(roomId, limit)
        .all<{
          id: string;
          room_id: string;
          user_id: string;
          op: MembershipOp;
          payload_json: string;
          attempts: number;
        }>()
    : await env.DB.prepare(
        `SELECT id, room_id, user_id, op, payload_json, attempts FROM membership_ops
         ORDER BY created_at ASC LIMIT ?`,
      )
        .bind(limit)
        .all<{
          id: string;
          room_id: string;
          user_id: string;
          op: MembershipOp;
          payload_json: string;
          attempts: number;
        }>();

  let applied = 0;
  for (const row of rows.results ?? []) {
    try {
      const payload = JSON.parse(row.payload_json) as MembershipOpPayload;
      await applyMembershipOp(env, row.room_id, row.user_id, row.op, payload);
      await env.DB.prepare(`DELETE FROM membership_ops WHERE id = ?`).bind(row.id).run();
      applied += 1;
    } catch {
      await env.DB.prepare(
        `UPDATE membership_ops SET attempts = attempts + 1 WHERE id = ?`,
      )
        .bind(row.id)
        .run();
      // Drop poison pills after many failures.
      if (row.attempts + 1 >= 8) {
        await env.DB.prepare(`DELETE FROM membership_ops WHERE id = ?`)
          .bind(row.id)
          .run();
      }
    }
  }
  return applied;
}

/**
 * Apply a membership write immediately; on failure enqueue for flush.
 * Returns true when the immediate write succeeded.
 */
export async function applyMembershipOrEnqueue(
  env: Env,
  roomId: string,
  userId: string,
  op: MembershipOp,
  payload: MembershipOpPayload = {},
): Promise<boolean> {
  try {
    await applyMembershipOp(env, roomId, userId, op, payload);
    return true;
  } catch {
    await enqueueMembershipOp(env, roomId, userId, op, payload);
    return false;
  }
}
