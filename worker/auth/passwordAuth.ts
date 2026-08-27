import { z } from "zod";
import type { Env } from "../env";
import {
  clearSessionCookie,
  createSession,
  GUEST_SESSION_TTL_MS,
  readSessionToken,
  requireUser,
  sessionCookieHeader,
} from "./session";
import { hashPassword, needsRehash, verifyPasswordOrDummy } from "./password";
import { verifyTurnstile } from "../lib/turnstile";
import { writeAnalytics } from "../lib/analytics";
import { errorJson, json, randomId, readJson, sha256Hex } from "../lib/http";

/** Create a guest user row + short-lived session. Shared by /auth/guest and join-as-guest. */
export async function createGuestUserAndSession(
  env: Env,
  displayName: string,
): Promise<{ userId: string; displayName: string; token: string }> {
  const userId = randomId("gst");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, display_name, username, email, password_hash, is_guest, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, 1, ?, ?)`,
  )
    .bind(userId, displayName, now, now)
    .run();

  const session = await createSession(env, userId, GUEST_SESSION_TTL_MS);
  writeAnalytics(env, "auth_guest", userId);
  return { userId, displayName, token: session.token };
}

const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9_]+$/, "Username may only use letters, numbers, and underscores.");

const passwordSchema = z.string().min(8).max(128);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.")
  .max(254);

const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(2).max(32).optional(),
  turnstileToken: z.string().min(1).optional(),
});

const loginSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  turnstileToken: z.string().min(1).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

const guestSchema = z.object({
  displayName: z.string().trim().min(2).max(32),
  turnstileToken: z.string().min(1).optional(),
});

function genericAuthFailure(action: string): Response {
  return errorJson(500, `${action} failed. Try again shortly.`);
}

export async function handleAuth(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === "/api/auth/me" && request.method === "GET") {
    const auth = await requireUser(env, request);
    if (!auth.ok) return errorJson(auth.status, auth.error);
    return json({
      user: {
        id: auth.user.id,
        displayName: auth.user.displayName,
        username: auth.user.username,
        isGuest: auth.user.isGuest,
      },
    });
  }

  if (path === "/api/auth/guest" && request.method === "POST") {
    try {
      if (!env.SESSION_SECRET) {
        return errorJson(500, "SESSION_SECRET is not configured on this Worker.");
      }
      const limited = await env.AUTH_RATE_LIMIT.limit({
        key: `guest:${request.headers.get("cf-connecting-ip") ?? "anon"}`,
      });
      if (!limited.success) return errorJson(429, "Too many guest sessions. Try again shortly.");

      const parsed = await readJson(request, guestSchema);
      if (!parsed.ok) return parsed.response;

      const okTurnstile = await verifyTurnstile(
        env,
        parsed.data.turnstileToken,
        request.headers.get("cf-connecting-ip"),
      );
      if (!okTurnstile) return errorJson(403, "Turnstile verification failed.");

      const guest = await createGuestUserAndSession(env, parsed.data.displayName);
      return new Response(
        JSON.stringify({
          user: {
            id: guest.userId,
            displayName: guest.displayName,
            username: null,
            isGuest: true,
          },
          privacyNote:
            "Guest names are not accounts. Create a full account to host tables or keep your handle.",
        }),
        {
          status: 201,
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
      console.error("guest failed", err instanceof Error ? err.message : err);
      return genericAuthFailure("Guest sign-in");
    }
  }

  if (path === "/api/auth/logout" && request.method === "POST") {
    const token = readSessionToken(request);
    if (token && env.SESSION_SECRET) {
      const tokenHash = await sha256Hex(`${env.SESSION_SECRET}:${token}`);
      await env.DB.prepare(
        `UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
      )
        .bind(Date.now(), tokenHash)
        .run();
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": clearSessionCookie(env.APP_ORIGIN),
      },
    });
  }

  if (path === "/api/auth/register" && request.method === "POST") {
    try {
      if (!env.SESSION_SECRET) {
        return errorJson(500, "SESSION_SECRET is not configured on this Worker.");
      }
      const limited = await env.AUTH_RATE_LIMIT.limit({
        key: `register:${request.headers.get("cf-connecting-ip") ?? "anon"}`,
      });
      if (!limited.success) return errorJson(429, "Too many attempts. Try again shortly.");

      const parsed = await readJson(request, registerSchema);
      if (!parsed.ok) return parsed.response;

      const okTurnstile = await verifyTurnstile(
        env,
        parsed.data.turnstileToken,
        request.headers.get("cf-connecting-ip"),
      );
      if (!okTurnstile) return errorJson(403, "Turnstile verification failed.");

      const existingUsername = await env.DB.prepare(`SELECT id FROM users WHERE username = ?`)
        .bind(parsed.data.username)
        .first();
      const existingEmail = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`)
        .bind(parsed.data.email)
        .first();
      if (existingUsername || existingEmail) {
        return errorJson(409, "Could not create that account. Try a different username or email.");
      }

      const userId = randomId("usr");
      const displayName = parsed.data.displayName ?? parsed.data.username;
      const passwordHash = await hashPassword(parsed.data.password);
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO users (id, display_name, username, email, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          userId,
          displayName,
          parsed.data.username,
          parsed.data.email,
          passwordHash,
          now,
          now,
        )
        .run();

      const session = await createSession(env, userId);
      writeAnalytics(env, "auth_register", userId);
      return new Response(
        JSON.stringify({
          user: { id: userId, displayName, username: parsed.data.username },
        }),
        {
          status: 201,
          headers: {
            "content-type": "application/json",
            "set-cookie": sessionCookieHeader(session.token, env.APP_ORIGIN),
          },
        },
      );
    } catch (err) {
      console.error("register failed", err instanceof Error ? err.message : err);
      return genericAuthFailure("Registration");
    }
  }

  if (path === "/api/auth/login" && request.method === "POST") {
    try {
      if (!env.SESSION_SECRET) {
        return errorJson(500, "SESSION_SECRET is not configured on this Worker.");
      }
      const ip = request.headers.get("cf-connecting-ip") ?? "anon";
      const limited = await env.AUTH_RATE_LIMIT.limit({ key: `login:${ip}` });
      if (!limited.success) return errorJson(429, "Too many attempts. Try again shortly.");

      const parsed = await readJson(request, loginSchema);
      if (!parsed.ok) return parsed.response;

      const okTurnstile = await verifyTurnstile(
        env,
        parsed.data.turnstileToken,
        request.headers.get("cf-connecting-ip"),
      );
      if (!okTurnstile) return errorJson(403, "Turnstile verification failed.");

      const row = await env.DB.prepare(
        `SELECT id, display_name, username, password_hash FROM users WHERE username = ?`,
      )
        .bind(parsed.data.username)
        .first<{
          id: string;
          display_name: string;
          username: string;
          password_hash: string | null;
        }>();

      const ok = await verifyPasswordOrDummy(parsed.data.password, row?.password_hash);
      if (!ok || !row) {
        return errorJson(401, "Invalid username or password.");
      }

      // Transparent upgrade when stored PBKDF2 iters lag the current target.
      if (row.password_hash && needsRehash(row.password_hash)) {
        const upgraded = await hashPassword(parsed.data.password);
        await env.DB.prepare(
          `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(upgraded, Date.now(), row.id)
          .run();
      }

      const session = await createSession(env, row.id);
      writeAnalytics(env, "auth_login", row.id);
      return new Response(
        JSON.stringify({
          user: {
            id: row.id,
            displayName: row.display_name,
            username: row.username,
          },
        }),
        {
          headers: {
            "content-type": "application/json",
            "set-cookie": sessionCookieHeader(session.token, env.APP_ORIGIN),
          },
        },
      );
    } catch (err) {
      console.error("login failed", err instanceof Error ? err.message : err);
      return genericAuthFailure("Login");
    }
  }

  /**
   * Unauthenticated password reset via username+email is disabled (account takeover).
   * Logged-in users can change passwords via /api/auth/change-password.
   */
  if (path === "/api/auth/reset-password" && request.method === "POST") {
    const limited = await env.AUTH_RATE_LIMIT.limit({
      key: `reset:${request.headers.get("cf-connecting-ip") ?? "anon"}`,
    });
    if (!limited.success) return errorJson(429, "Too many attempts. Try again shortly.");
    return errorJson(
      403,
      "Password reset by username and email is disabled. Sign in and change your password, or create a new account.",
    );
  }

  if (path === "/api/auth/change-password" && request.method === "POST") {
    try {
      if (!env.SESSION_SECRET) {
        return errorJson(500, "SESSION_SECRET is not configured on this Worker.");
      }
      const auth = await requireUser(env, request);
      if (!auth.ok) return errorJson(auth.status, auth.error);
      if (auth.user.isGuest) {
        return errorJson(403, "Guests do not have passwords. Create a full account first.");
      }

      const limited = await env.AUTH_RATE_LIMIT.limit({
        key: `change-pw:${auth.user.id}`,
      });
      if (!limited.success) return errorJson(429, "Too many attempts. Try again shortly.");

      const parsed = await readJson(request, changePasswordSchema);
      if (!parsed.ok) return parsed.response;

      const row = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`)
        .bind(auth.user.id)
        .first<{ password_hash: string | null }>();
      const ok = await verifyPasswordOrDummy(
        parsed.data.currentPassword,
        row?.password_hash,
      );
      if (!ok) return errorJson(401, "Current password is incorrect.");

      const passwordHash = await hashPassword(parsed.data.newPassword);
      const now = Date.now();
      await env.DB.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`)
        .bind(passwordHash, now, auth.user.id)
        .run();

      // Revoke sibling sessions; keep the caller's cookie by re-issuing below.
      await env.DB.prepare(
        `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
      )
        .bind(now, auth.user.id)
        .run();

      const session = await createSession(env, auth.user.id);
      writeAnalytics(env, "auth_change_password", auth.user.id);
      return new Response(
        JSON.stringify({ ok: true, message: "Password updated." }),
        {
          headers: {
            "content-type": "application/json",
            "set-cookie": sessionCookieHeader(session.token, env.APP_ORIGIN),
          },
        },
      );
    } catch (err) {
      console.error("change-password failed", err instanceof Error ? err.message : err);
      return genericAuthFailure("Password change");
    }
  }

  return null;
}
