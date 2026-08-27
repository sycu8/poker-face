import type { Env } from "../env";
import { sha256Hex } from "../lib/http";

const SESSION_COOKIE = "pf_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
/** Short-lived guest sessions (24h). */
export const GUEST_SESSION_TTL_MS = 1000 * 60 * 60 * 24;

export function sessionCookieHeader(
  token: string,
  origin: string,
  maxAgeSeconds = SESSION_TTL_MS / 1000,
): string {
  const url = new URL(origin);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSeconds)}${secure}`;
}

export function clearSessionCookie(origin: string): string {
  const url = new URL(origin);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)pf_session=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export interface SessionUser {
  id: string;
  displayName: string;
  username: string | null;
  sessionId: string;
  isGuest: boolean;
}

export async function requireUser(
  env: Env,
  request: Request,
): Promise<{ ok: true; user: SessionUser } | { ok: false; status: number; error: string }> {
  const token = readSessionToken(request);
  if (!token) return { ok: false, status: 401, error: "Sign in required." };
  const tokenHash = await sha256Hex(`${env.SESSION_SECRET}:${token}`);
  const row = await env.DB.prepare(
    `SELECT s.id as session_id, s.expires_at, s.revoked_at,
            u.id as user_id, u.display_name, u.username, u.is_guest
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{
      session_id: string;
      expires_at: number;
      revoked_at: number | null;
      user_id: string;
      display_name: string;
      username: string | null;
      is_guest: number | null;
    }>();
  if (!row || row.revoked_at || row.expires_at < Date.now()) {
    return { ok: false, status: 401, error: "Session expired." };
  }
  return {
    ok: true,
    user: {
      id: row.user_id,
      displayName: row.display_name,
      username: row.username,
      sessionId: row.session_id,
      isGuest: Boolean(row.is_guest),
    },
  };
}

export async function createSession(
  env: Env,
  userId: string,
  ttlMs: number = SESSION_TTL_MS,
): Promise<{ token: string; expiresAt: number }> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256Hex(`${env.SESSION_SECRET}:${token}`);
  const expiresAt = Date.now() + ttlMs;
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, tokenHash, expiresAt, Date.now())
    .run();
  return { token, expiresAt };
}

const REVOKED_RETENTION_MS = 1000 * 60 * 60 * 24 * 7;

/**
 * Delete expired sessions and revoked sessions older than 7 days.
 * Does not touch active (non-expired, non-revoked) sessions.
 */
export async function purgeExpiredSessions(
  env: Env,
  limit = 100,
): Promise<{ deleted: number }> {
  const now = Date.now();
  const revokedCutoff = now - REVOKED_RETENTION_MS;
  const result = await env.DB.prepare(
    `DELETE FROM sessions
     WHERE id IN (
       SELECT id FROM sessions
       WHERE expires_at < ?
          OR (revoked_at IS NOT NULL AND revoked_at < ?)
       LIMIT ?
     )`,
  )
    .bind(now, revokedCutoff, limit)
    .run();
  return { deleted: result.meta.changes ?? 0 };
}
