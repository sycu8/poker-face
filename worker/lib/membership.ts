import type { Env } from "../env";

/** Membership statuses that still grant table access (WS, ledger, hands, seat). */
export const ACTIVE_MEMBER_STATUSES = ["seated", "away", "spectator"] as const;
export type ActiveMemberStatus = (typeof ACTIVE_MEMBER_STATUSES)[number];

const ACTIVE_SQL = `'seated','away','spectator'`;

export type ActiveMemberRow = {
  user_id: string;
  display_name: string;
  status: ActiveMemberStatus;
  role: string;
  seat_index: number | null;
};

/** Active room member, or null if missing / kicked / left. */
export async function getActiveMember(
  env: Env,
  roomId: string,
  userId: string,
): Promise<ActiveMemberRow | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, display_name, status, role, seat_index
     FROM room_members
     WHERE room_id = ? AND user_id = ? AND status IN (${ACTIVE_SQL})`,
  )
    .bind(roomId, userId)
    .first<ActiveMemberRow>();
  return row ?? null;
}

export async function requireActiveMember(
  env: Env,
  roomId: string,
  userId: string,
): Promise<{ ok: true; member: ActiveMemberRow } | { ok: false }> {
  const member = await getActiveMember(env, roomId, userId);
  if (!member) return { ok: false };
  return { ok: true, member };
}
