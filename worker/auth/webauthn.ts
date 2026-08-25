import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import type { Env } from "../env";
import { createSession, requireUser, sessionCookieHeader } from "./session";
import { errorJson, json, randomId, readJson, sha256Hex } from "../lib/http";

const registerStartSchema = z.object({
  displayName: z.string().trim().min(2).max(32),
  turnstileToken: z.string().min(1).optional(),
});

const registerFinishSchema = z.object({
  challengeId: z.string().min(1),
  displayName: z.string().trim().min(2).max(32),
  response: z.unknown(),
});

const loginStartSchema = z.object({
  turnstileToken: z.string().min(1).optional(),
});

const loginFinishSchema = z.object({
  challengeId: z.string().min(1),
  response: z.unknown(),
});

async function verifyTurnstile(env: Env, token: string | undefined, ip: string | null) {
  if (env.ENVIRONMENT === "local" && !env.TURNSTILE_SECRET_KEY) {
    return true;
  }
  if (!env.TURNSTILE_SECRET_KEY) return false;
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
    return json({ user: { id: auth.user.id, displayName: auth.user.displayName } });
  }

  if (path === "/api/auth/logout" && request.method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": `${"pf_session"}=; Path=/; Max-Age=0`,
      },
    });
  }

  if (path === "/api/auth/register/options" && request.method === "POST") {
    const limited = await env.AUTH_RATE_LIMIT.limit({
      key: request.headers.get("cf-connecting-ip") ?? "anon",
    });
    if (!limited.success) return errorJson(429, "Too many attempts. Try again shortly.");

    const parsed = await readJson(request, registerStartSchema);
    if (!parsed.ok) return parsed.response;
    const okTurnstile = await verifyTurnstile(
      env,
      parsed.data.turnstileToken,
      request.headers.get("cf-connecting-ip"),
    );
    if (!okTurnstile) return errorJson(403, "Turnstile verification failed.");

    const userId = randomId("usr");
    const options = await generateRegistrationOptions({
      rpName: env.WEBAUTHN_RP_NAME,
      rpID: env.WEBAUTHN_RP_ID,
      userName: parsed.data.displayName,
      userID: new TextEncoder().encode(userId),
      userDisplayName: parsed.data.displayName,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });
    const challengeId = randomId("ch");
    await env.DB.prepare(
      `INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at, created_at)
       VALUES (?, ?, 'register', ?, ?, ?)`,
    )
      .bind(challengeId, userId, options.challenge, Date.now() + 5 * 60_000, Date.now())
      .run();
    return json({
      challengeId,
      userId,
      displayName: parsed.data.displayName,
      options,
      turnstileSiteKey: env.TURNSTILE_SITE_KEY,
    });
  }

  if (path === "/api/auth/register/verify" && request.method === "POST") {
    const parsed = await readJson(request, registerFinishSchema);
    if (!parsed.ok) return parsed.response;
    const challenge = await env.DB.prepare(
      `SELECT * FROM webauthn_challenges WHERE id = ? AND purpose = 'register'`,
    )
      .bind(parsed.data.challengeId)
      .first<{
        id: string;
        user_id: string;
        challenge: string;
        expires_at: number;
      }>();
    if (!challenge || challenge.expires_at < Date.now() || !challenge.user_id) {
      return errorJson(400, "Challenge expired.");
    }
    const verification = await verifyRegistrationResponse({
      response: parsed.data.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: env.APP_ORIGIN,
      expectedRPID: env.WEBAUTHN_RP_ID,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return errorJson(400, "Passkey registration failed.");
    }
    const info = verification.registrationInfo;
    const now = Date.now();
    const credentialId = info.credential.id;
    const publicKey = bytesToBase64Url(info.credential.publicKey);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      ).bind(challenge.user_id, parsed.data.displayName, now, now),
      env.DB.prepare(
        `INSERT INTO webauthn_credentials
         (id, user_id, public_key, counter, device_type, backed_up, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        credentialId,
        challenge.user_id,
        publicKey,
        info.credential.counter,
        info.credentialDeviceType,
        info.credentialBackedUp ? 1 : 0,
        now,
      ),
      env.DB.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).bind(challenge.id),
    ]);
    const session = await createSession(env, challenge.user_id);
    return new Response(
      JSON.stringify({
        user: { id: challenge.user_id, displayName: parsed.data.displayName },
      }),
      {
        headers: {
          "content-type": "application/json",
          "set-cookie": sessionCookieHeader(session.token, env.APP_ORIGIN),
        },
      },
    );
  }

  if (path === "/api/auth/login/options" && request.method === "POST") {
    const limited = await env.AUTH_RATE_LIMIT.limit({
      key: request.headers.get("cf-connecting-ip") ?? "anon",
    });
    if (!limited.success) return errorJson(429, "Too many attempts. Try again shortly.");
    const parsed = await readJson(request, loginStartSchema);
    if (!parsed.ok) return parsed.response;
    const okTurnstile = await verifyTurnstile(
      env,
      parsed.data.turnstileToken,
      request.headers.get("cf-connecting-ip"),
    );
    if (!okTurnstile) return errorJson(403, "Turnstile verification failed.");

    const options = await generateAuthenticationOptions({
      rpID: env.WEBAUTHN_RP_ID,
      userVerification: "preferred",
    });
    const challengeId = randomId("ch");
    await env.DB.prepare(
      `INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at, created_at)
       VALUES (?, NULL, 'login', ?, ?, ?)`,
    )
      .bind(challengeId, options.challenge, Date.now() + 5 * 60_000, Date.now())
      .run();
    return json({ challengeId, options, turnstileSiteKey: env.TURNSTILE_SITE_KEY });
  }

  if (path === "/api/auth/login/verify" && request.method === "POST") {
    const parsed = await readJson(request, loginFinishSchema);
    if (!parsed.ok) return parsed.response;
    const challenge = await env.DB.prepare(
      `SELECT * FROM webauthn_challenges WHERE id = ? AND purpose = 'login'`,
    )
      .bind(parsed.data.challengeId)
      .first<{ id: string; challenge: string; expires_at: number }>();
    if (!challenge || challenge.expires_at < Date.now()) {
      return errorJson(400, "Challenge expired.");
    }
    const response = parsed.data.response as AuthenticationResponseJSON;
    const credId = response.id;
    const cred = await env.DB.prepare(
      `SELECT c.*, u.display_name FROM webauthn_credentials c
       JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
    )
      .bind(credId)
      .first<{
        id: string;
        user_id: string;
        public_key: string;
        counter: number;
        display_name: string;
      }>();
    if (!cred) return errorJson(400, "Unknown passkey.");

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: env.APP_ORIGIN,
      expectedRPID: env.WEBAUTHN_RP_ID,
      credential: {
        id: cred.id,
        publicKey: base64UrlToBytes(cred.public_key),
        counter: cred.counter,
      },
    });
    if (!verification.verified) return errorJson(400, "Passkey login failed.");

    await env.DB.batch([
      env.DB.prepare(`UPDATE webauthn_credentials SET counter = ? WHERE id = ?`).bind(
        verification.authenticationInfo.newCounter,
        cred.id,
      ),
      env.DB.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).bind(challenge.id),
    ]);
    const session = await createSession(env, cred.user_id);
    return new Response(
      JSON.stringify({
        user: { id: cred.user_id, displayName: cred.display_name },
      }),
      {
        headers: {
          "content-type": "application/json",
          "set-cookie": sessionCookieHeader(session.token, env.APP_ORIGIN),
        },
      },
    );
  }

  void sha256Hex;
  return null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
