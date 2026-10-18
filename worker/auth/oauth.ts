import type { Env } from "../env";
import { writeAnalytics } from "../lib/analytics";
import { errorJson, json, randomId } from "../lib/http";
import { createSession, sessionCookieHeader } from "./session";

export type OAuthProvider = "github" | "google";

const STATE_TTL_MS = 1000 * 60 * 10;
const OAUTH_SCOPES: Record<OAuthProvider, string> = {
  github: "read:user user:email",
  google: "openid email profile",
};

type OAuthStatePayload = {
  p: OAuthProvider;
  n: string;
  e: number;
  invite?: string;
};

export type ProviderProfile = {
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
};

export function oauthProvidersConfigured(env: Env): {
  github: boolean;
  google: boolean;
} {
  return {
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  };
}

function providerConfigured(env: Env, provider: OAuthProvider): boolean {
  const flags = oauthProvidersConfigured(env);
  return flags[provider];
}

function callbackUrl(env: Env, provider: OAuthProvider): string {
  return `${env.APP_ORIGIN}/api/auth/oauth/${provider}/callback`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const b64 = padded + "=".repeat(padLen);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function textToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

function base64UrlToText(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToBase64Url(new Uint8Array(sig));
}

async function hmacVerify(
  secret: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const expected = await hmacSign(secret, message);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

function oauthStateKvKey(nonce: string): string {
  return `oauth_state:${nonce}`;
}

/**
 * Build a signed, time-limited OAuth state token (CSRF + invite return).
 * When `kv` is provided, the nonce is stored so callbacks can enforce single-use.
 */
export async function createOAuthState(
  secret: string,
  provider: OAuthProvider,
  invite?: string | null,
  kv?: KVNamespace,
): Promise<string> {
  const nonce = crypto.randomUUID();
  const payload: OAuthStatePayload = {
    p: provider,
    n: nonce,
    e: Date.now() + STATE_TTL_MS,
  };
  if (invite && /^[A-Za-z0-9]{4,12}$/.test(invite)) {
    payload.invite = invite.toUpperCase();
  }
  if (kv) {
    await kv.put(oauthStateKvKey(nonce), provider, {
      expirationTtl: Math.ceil(STATE_TTL_MS / 1000),
    });
  }
  const body = textToBase64Url(JSON.stringify(payload));
  const sig = await hmacSign(secret, body);
  return `${body}.${sig}`;
}

/**
 * Verify OAuth state. When `kv` is provided, the nonce must exist and is deleted
 * (single-use) so replayed callbacks fail.
 */
export async function parseOAuthState(
  secret: string,
  state: string,
  expectedProvider: OAuthProvider,
  kv?: KVNamespace,
): Promise<{ ok: true; invite?: string } | { ok: false; error: string }> {
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, error: "Invalid OAuth state." };
  }
  const [body, sig] = parts;
  if (!(await hmacVerify(secret, body, sig))) {
    return { ok: false, error: "Invalid OAuth state." };
  }
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(base64UrlToText(body)) as OAuthStatePayload;
  } catch {
    return { ok: false, error: "Invalid OAuth state." };
  }
  if (payload.p !== expectedProvider) {
    return { ok: false, error: "OAuth provider mismatch." };
  }
  if (typeof payload.e !== "number" || payload.e < Date.now()) {
    return { ok: false, error: "OAuth state expired. Try again." };
  }
  if (typeof payload.n !== "string" || !payload.n) {
    return { ok: false, error: "Invalid OAuth state." };
  }
  if (kv) {
    const key = oauthStateKvKey(payload.n);
    const stored = await kv.get(key);
    if (!stored || stored !== expectedProvider) {
      return { ok: false, error: "OAuth state already used or unknown." };
    }
    await kv.delete(key);
  }
  return { ok: true, invite: payload.invite };
}

function redirectWithError(env: Env, code: string, invite?: string): Response {
  const url = new URL("/auth", env.APP_ORIGIN);
  url.searchParams.set("oauth_error", code);
  if (invite) url.searchParams.set("invite", invite);
  return Response.redirect(url.toString(), 302);
}

function redirectAuthed(env: Env, invite?: string): string {
  const url = new URL("/", env.APP_ORIGIN);
  if (invite) url.searchParams.set("invite", invite);
  url.searchParams.set("oauth", "1");
  return url.toString();
}

async function exchangeGitHubCode(
  env: Env,
  code: string,
): Promise<{ accessToken: string } | { error: string }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "poker-faces",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(env, "github"),
    }),
  });
  if (!res.ok) return { error: "GitHub token exchange failed." };
  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    return { error: data.error_description ?? data.error ?? "GitHub denied access." };
  }
  return { accessToken: data.access_token };
}

async function fetchGitHubProfile(
  accessToken: string,
): Promise<ProviderProfile | { error: string }> {
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "poker-faces",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!userRes.ok) return { error: "Could not load GitHub profile." };
  const user = (await userRes.json()) as {
    id?: number | string;
    login?: string;
    name?: string | null;
    email?: string | null;
  };
  if (user.id == null) return { error: "GitHub profile missing id." };

  let email: string | null =
    typeof user.email === "string" && user.email.includes("@")
      ? user.email.toLowerCase()
      : null;
  let emailVerified = Boolean(email);

  if (!email) {
    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "poker-faces",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{
        email?: string;
        primary?: boolean;
        verified?: boolean;
      }>;
      const primary =
        emails.find((e) => e.primary && e.verified && e.email) ??
        emails.find((e) => e.verified && e.email);
      if (primary?.email) {
        email = primary.email.toLowerCase();
        emailVerified = true;
      }
    }
  }

  const displayName =
    (user.name && user.name.trim()) ||
    (user.login && user.login.trim()) ||
    `GitHub ${user.id}`;

  return {
    providerUserId: String(user.id),
    email,
    emailVerified,
    displayName: displayName.slice(0, 32),
  };
}

async function exchangeGoogleCode(
  env: Env,
  code: string,
): Promise<{ accessToken: string } | { error: string }> {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: callbackUrl(env, "google"),
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return { error: "Google token exchange failed." };
  const data = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    return { error: data.error_description ?? data.error ?? "Google denied access." };
  }
  return { accessToken: data.access_token };
}

async function fetchGoogleProfile(
  accessToken: string,
): Promise<ProviderProfile | { error: string }> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { error: "Could not load Google profile." };
  const user = (await res.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    given_name?: string;
  };
  if (!user.sub) return { error: "Google profile missing subject." };
  const email =
    typeof user.email === "string" && user.email.includes("@")
      ? user.email.toLowerCase()
      : null;
  const displayName =
    (user.name && user.name.trim()) ||
    (user.given_name && user.given_name.trim()) ||
    (email ? email.split("@")[0]! : `Google ${user.sub.slice(0, 8)}`);

  return {
    providerUserId: user.sub,
    email,
    emailVerified: Boolean(user.email_verified && email),
    displayName: displayName.slice(0, 32),
  };
}

/**
 * Find or create a full (non-guest) user for an OAuth identity.
 * Links only by provider subject — never by email alone.
 * Password accounts use unverified emails, so silent email auto-link would
 * allow account takeover (register with victim email → victim OAuth signs in).
 */
export async function upsertOAuthUser(
  env: Env,
  provider: OAuthProvider,
  profile: ProviderProfile,
): Promise<{ userId: string; displayName: string; username: string | null }> {
  const now = Date.now();
  const existingLink = await env.DB.prepare(
    `SELECT oa.user_id, u.display_name, u.username
     FROM oauth_accounts oa
     JOIN users u ON u.id = oa.user_id
     WHERE oa.provider = ? AND oa.provider_user_id = ?`,
  )
    .bind(provider, profile.providerUserId)
    .first<{ user_id: string; display_name: string; username: string | null }>();

  if (existingLink) {
    await env.DB.prepare(
      `UPDATE oauth_accounts SET email = ?, updated_at = ? WHERE provider = ? AND provider_user_id = ?`,
    )
      .bind(profile.email, now, provider, profile.providerUserId)
      .run();
    return {
      userId: existingLink.user_id,
      displayName: existingLink.display_name,
      username: existingLink.username,
    };
  }

  const userId = randomId("usr");
  const displayName = profile.displayName;
  await env.DB.prepare(
    `INSERT INTO users (id, display_name, username, email, password_hash, is_guest, created_at, updated_at)
     VALUES (?, ?, NULL, ?, NULL, 0, ?, ?)`,
  )
    .bind(userId, displayName, profile.email, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      randomId("oa"),
      userId,
      provider,
      profile.providerUserId,
      profile.email,
      now,
      now,
    )
    .run();

  return { userId, displayName, username: null };
}

function authorizeUrl(env: Env, provider: OAuthProvider, state: string): string {
  if (provider === "github") {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
    url.searchParams.set("redirect_uri", callbackUrl(env, "github"));
    url.searchParams.set("scope", OAUTH_SCOPES.github);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "true");
    return url.toString();
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", callbackUrl(env, "google"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPES.google);
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function handleOAuth(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const startMatch = path.match(/^\/api\/auth\/oauth\/(github|google)$/);
  if (startMatch && request.method === "GET") {
    const provider = startMatch[1] as OAuthProvider;
    if (!env.SESSION_SECRET) {
      return errorJson(500, "SESSION_SECRET is not configured on this Worker.");
    }
    if (!providerConfigured(env, provider)) {
      return errorJson(503, `${provider} sign-in is not configured.`);
    }

    const limited = await env.AUTH_RATE_LIMIT.limit({
      key: `oauth-start:${provider}:${request.headers.get("cf-connecting-ip") ?? "anon"}`,
    });
    if (!limited.success) {
      return errorJson(429, "Too many attempts. Try again shortly.");
    }

    const url = new URL(request.url);
    const invite = url.searchParams.get("invite");
    const state = await createOAuthState(
      env.SESSION_SECRET,
      provider,
      invite,
      env.CONFIG_KV,
    );
    return Response.redirect(authorizeUrl(env, provider, state), 302);
  }

  const callbackMatch = path.match(/^\/api\/auth\/oauth\/(github|google)\/callback$/);
  if (callbackMatch && request.method === "GET") {
    const provider = callbackMatch[1] as OAuthProvider;
    if (!env.SESSION_SECRET) {
      return redirectWithError(env, "server_config");
    }
    if (!providerConfigured(env, provider)) {
      return redirectWithError(env, "not_configured");
    }

    const limited = await env.AUTH_RATE_LIMIT.limit({
      key: `oauth-cb:${provider}:${request.headers.get("cf-connecting-ip") ?? "anon"}`,
    });
    if (!limited.success) {
      return redirectWithError(env, "rate_limited");
    }

    const url = new URL(request.url);
    const errorParam = url.searchParams.get("error");
    if (errorParam) {
      return redirectWithError(env, "denied");
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return redirectWithError(env, "missing_code");
    }

    const parsedState = await parseOAuthState(
      env.SESSION_SECRET,
      state,
      provider,
      env.CONFIG_KV,
    );
    if (!parsedState.ok) {
      return redirectWithError(env, "bad_state");
    }
    const invite = parsedState.invite;

    try {
      const tokenResult =
        provider === "github"
          ? await exchangeGitHubCode(env, code)
          : await exchangeGoogleCode(env, code);
      if ("error" in tokenResult) {
        console.error("oauth token", provider, tokenResult.error);
        return redirectWithError(env, "token", invite);
      }

      const profileResult =
        provider === "github"
          ? await fetchGitHubProfile(tokenResult.accessToken)
          : await fetchGoogleProfile(tokenResult.accessToken);
      if ("error" in profileResult) {
        console.error("oauth profile", provider, profileResult.error);
        return redirectWithError(env, "profile", invite);
      }

      const user = await upsertOAuthUser(env, provider, profileResult);
      const session = await createSession(env, user.userId);
      writeAnalytics(env, `auth_oauth_${provider}`, user.userId);

      return new Response(null, {
        status: 302,
        headers: {
          location: redirectAuthed(env, invite),
          "set-cookie": sessionCookieHeader(session.token, env.APP_ORIGIN),
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      console.error(
        "oauth callback failed",
        provider,
        err instanceof Error ? err.message : err,
      );
      return redirectWithError(env, "failed", invite);
    }
  }

  if (path === "/api/auth/oauth/providers" && request.method === "GET") {
    return json({ oauth: oauthProvidersConfigured(env) });
  }

  return null;
}
