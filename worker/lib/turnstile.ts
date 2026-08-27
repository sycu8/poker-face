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

function expectedHostname(appOrigin: string | undefined): string | null {
  if (!appOrigin) return null;
  try {
    return new URL(appOrigin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Verify Cloudflare Turnstile when TURNSTILE_SECRET_KEY is configured.
 * Local/dev may omit the secret (fail-open). Staging/production fail closed
 * so misconfigured deploys cannot skip bot protection.
 *
 * When APP_ORIGIN is set, response hostname must match that origin's host.
 * When expectedAction is provided, response action must match.
 */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip: string | null,
  expectedAction?: string,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) {
    return isDevEnvironment(env);
  }
  if (!token) return false;

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  if (ip) body.set("remoteip", ip);

  let data: SiteverifyResponse;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    data = (await res.json()) as SiteverifyResponse;
  } catch {
    return false;
  }

  if (!data.success) return false;

  const wantHost = expectedHostname(env.APP_ORIGIN);
  if (wantHost) {
    const gotHost = (data.hostname ?? "").toLowerCase();
    if (!gotHost || gotHost !== wantHost) return false;
  }

  if (expectedAction !== undefined && expectedAction !== "") {
    if ((data.action ?? "") !== expectedAction) return false;
  }

  return true;
}
