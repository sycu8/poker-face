import type { Env } from "../env";
import { requireSuperAdmin } from "../auth/session";
import { ACTIVE_MEMBER_STATUSES } from "../lib/membership";
import { writeAnalytics } from "../lib/analytics";
import { errorJson, json } from "../lib/http";

const ACTIVE_MEMBER_SQL = ACTIVE_MEMBER_STATUSES.map((s) => `'${s}'`).join(",");
const DEFAULT_PERIOD_DAYS = 5;
const MAX_PERIOD_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type AdminRoomStats = {
  total: number;
  createdInPeriod: number;
  open: number;
  activeInPeriod: number;
  withHandsInPeriod: number;
  closedInPeriod: number;
};

export type AdminUserStats = {
  total: number;
  registeredInPeriod: number;
  guests: number;
  /** Distinct users who created a session in the period (signed in). */
  activeInPeriod: number;
  /** Distinct users with a currently valid (non-expired, non-revoked) session. */
  withActiveSession: number;
  /** Distinct users currently seated/away/spectator in an open room. */
  activeMembers: number;
};

export async function queryAdminStats(
  env: Env,
  periodDays: number,
): Promise<{
  periodDays: number;
  periodStart: number;
  rooms: AdminRoomStats;
  users: AdminUserStats;
}> {
  const days = Math.min(Math.max(1, periodDays), MAX_PERIOD_DAYS);
  const periodStart = Date.now() - days * MS_PER_DAY;

  const roomsRow = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM rooms) AS total,
       (SELECT COUNT(*) FROM rooms WHERE created_at >= ?) AS created_in_period,
       (SELECT COUNT(*) FROM rooms WHERE status = 'open') AS open_count,
       (SELECT COUNT(*) FROM rooms WHERE status = 'closed' AND updated_at >= ?) AS closed_in_period,
       (SELECT COUNT(DISTINCT r.id)
        FROM rooms r
        JOIN room_members m ON m.room_id = r.id
        WHERE r.status = 'open'
          AND m.status IN (${ACTIVE_MEMBER_SQL})
          AND r.updated_at >= ?) AS active_in_period,
       (SELECT COUNT(DISTINCT room_id) FROM hand_summaries WHERE created_at >= ?) AS with_hands_in_period`,
  )
    .bind(periodStart, periodStart, periodStart, periodStart)
    .first<{
      total: number;
      created_in_period: number;
      open_count: number;
      closed_in_period: number;
      active_in_period: number;
      with_hands_in_period: number;
    }>();

  const now = Date.now();
  const usersRow = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users) AS total,
       (SELECT COUNT(*) FROM users WHERE created_at >= ? AND is_guest = 0) AS registered_in_period,
       (SELECT COUNT(*) FROM users WHERE is_guest = 1) AS guests,
       (SELECT COUNT(DISTINCT user_id) FROM sessions
        WHERE created_at >= ? AND revoked_at IS NULL) AS active_in_period,
       (SELECT COUNT(DISTINCT user_id) FROM sessions
        WHERE revoked_at IS NULL AND expires_at > ?) AS with_active_session,
       (SELECT COUNT(DISTINCT m.user_id)
        FROM room_members m
        JOIN rooms r ON r.id = m.room_id
        WHERE r.status = 'open'
          AND m.status IN (${ACTIVE_MEMBER_SQL})) AS active_members`,
  )
    .bind(periodStart, periodStart, now)
    .first<{
      total: number;
      registered_in_period: number;
      guests: number;
      active_in_period: number;
      with_active_session: number;
      active_members: number;
    }>();

  return {
    periodDays: days,
    periodStart,
    rooms: {
      total: roomsRow?.total ?? 0,
      createdInPeriod: roomsRow?.created_in_period ?? 0,
      open: roomsRow?.open_count ?? 0,
      activeInPeriod: roomsRow?.active_in_period ?? 0,
      withHandsInPeriod: roomsRow?.with_hands_in_period ?? 0,
      closedInPeriod: roomsRow?.closed_in_period ?? 0,
    },
    users: {
      total: usersRow?.total ?? 0,
      registeredInPeriod: usersRow?.registered_in_period ?? 0,
      guests: usersRow?.guests ?? 0,
      activeInPeriod: usersRow?.active_in_period ?? 0,
      withActiveSession: usersRow?.with_active_session ?? 0,
      activeMembers: usersRow?.active_members ?? 0,
    },
  };
}

function parsePeriodDays(url: URL): number {
  const raw = url.searchParams.get("days");
  if (!raw) return DEFAULT_PERIOD_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_PERIOD_DAYS;
  return Math.min(n, MAX_PERIOD_DAYS);
}

export async function handleAdmin(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === "/api/admin/stats" && request.method === "GET") {
    const auth = await requireSuperAdmin(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);

    const limited = await env.AUTH_RATE_LIMIT.limit({
      key: `admin-stats:${auth.user.id}`,
    });
    if (!limited.success) {
      return errorJson(429, "Too many admin requests. Try again shortly.");
    }

    const stats = await queryAdminStats(env, parsePeriodDays(new URL(request.url)));
    writeAnalytics(env, "admin_stats_view", auth.user.id, [stats.periodDays]);
    return json(stats);
  }

  return null;
}
