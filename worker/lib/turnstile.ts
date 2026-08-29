import type { Env } from "../env";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 10_000;

type SiteverifyResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
};

function isDevEnvironment(env: Env): boolean {
  const envName = (env.ENVIRONMENT ?? "").toLowerCase();
  return envName === "local" || envName === "development" || envName === "dev";
}

/** Deployment-specific frontend hostnames allowed by siteverify. */
export function expectedHostnames(env: Env): Set<string> {
  const fromEnv = (env.TURNSTILE_HOSTNAMES ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length > 0) return new Set(fromEnv);
  if (!env.APP_ORIGIN) return new Set();
  try {
    return new Set([new URL(env.APP_ORIGIN).hostname.toLowerCase()]);
  } catch {
    return new Set();
  }
}

/**
 * Canonical Cloudflare Turnstile siteverify.
 *
 * Requires success, matching action, and an approved hostname.
 * Local/dev may omit TURNSTILE_SECRET (fail-open). Staging/production fail closed.
 */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip: string | null,
  expectedAction: string,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) {
    return isDevEnvironment(env);
  }

  const hosts = expectedHostnames(env);
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 2048 ||
    hosts.size === 0 ||
    !expectedAction
  ) {
    return false;
  }

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
  });
  if (ip) body.set("remoteip", ip);

  let data: SiteverifyResponse;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    data = (await res.json()) as SiteverifyResponse;
  } catch {
    return false;
  }

  if (!data.success) return false;
  if ((data.action ?? "") !== expectedAction) return false;
  const gotHost = (data.hostname ?? "").toLowerCase();
  if (!gotHost || !hosts.has(gotHost)) return false;
  return true;
}
