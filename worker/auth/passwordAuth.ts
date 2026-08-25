import { z } from "zod";
import type { Env } from "../env";
import {
  clearSessionCookie,
  createSession,
  readSessionToken,
  requireUser,
  sessionCookieHeader,
} from "./session";
import { hashPassword, verifyPassword } from "./password";
import { errorJson, json, randomId, readJson, sha256Hex } from "../lib/http";

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

const resetPasswordSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  newPassword: passwordSchema,
  turnstileToken: z.string().min(1).optional(),
});

async function verifyTurnstile(env: Env, token: string | undefined, ip: string | null) {
  // Skip until TURNSTILE_SECRET_KEY is configured (local or early deploy).
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  if (ip) body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const data = (await res.json()) as { success?: boolean };
  return Boolean(data.success);
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
      },
    });
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
        key: request.headers.get("cf-connecting-ip") ?? "anon",
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
      if (existingUsername) return errorJson(409, "That username is taken.");

      const existingEmail = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`)
        .bind(parsed.data.email)
        .first();
      if (existingEmail) return errorJson(409, "That email is already registered.");

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
      const message = err instanceof Error ? err.message : "Registration failed.";
      console.error("register failed", message);
      return errorJson(500, message);
    }
  }

  if (path === "/api/auth/login" && request.method === "POST") {
    try {
      if (!env.SESSION_SECRET) {
        return errorJson(500, "SESSION_SECRET is not configured on this Worker.");
      }
      const limited = await env.AUTH_RATE_LIMIT.limit({
        key: request.headers.get("cf-connecting-ip") ?? "anon",
      });
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

      if (!row?.password_hash) {
        return errorJson(401, "Invalid username or password.");
      }
      const ok = await verifyPassword(parsed.data.password, row.password_hash);
      if (!ok) return errorJson(401, "Invalid username or password.");

      const session = await createSession(env, row.id);
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
      const message = err instanceof Error ? err.message : "Login failed.";
      console.error("login failed", message);
      return errorJson(500, message);
    }
  }

  if (path === "/api/auth/reset-password" && request.method === "POST") {
    try {
      if (!env.SESSION_SECRET) {
        return errorJson(500, "SESSION_SECRET is not configured on this Worker.");
      }
      const limited = await env.AUTH_RATE_LIMIT.limit({
        key: request.headers.get("cf-connecting-ip") ?? "anon",
      });
      if (!limited.success) return errorJson(429, "Too many attempts. Try again shortly.");

      const parsed = await readJson(request, resetPasswordSchema);
      if (!parsed.ok) return parsed.response;

      const okTurnstile = await verifyTurnstile(
        env,
        parsed.data.turnstileToken,
        request.headers.get("cf-connecting-ip"),
      );
      if (!okTurnstile) return errorJson(403, "Turnstile verification failed.");

      // Require username + email to match the same row; single error for any miss.
      const row = await env.DB.prepare(
        `SELECT id FROM users WHERE username = ? AND email = ?`,
      )
        .bind(parsed.data.username, parsed.data.email)
        .first<{ id: string }>();

      if (!row) {
        return errorJson(400, "Username and email do not match our records.");
      }

      const passwordHash = await hashPassword(parsed.data.newPassword);
      const now = Date.now();
      await env.DB.prepare(
        `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(passwordHash, now, row.id)
        .run();

      // Force re-login after reset.
      await env.DB.prepare(
        `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
      )
        .bind(now, row.id)
        .run();

      return json({ ok: true, message: "Password updated. You can sign in with your new password." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Password reset failed.";
      console.error("reset-password failed", message);
      return errorJson(500, message);
    }
  }

  return null;
}
