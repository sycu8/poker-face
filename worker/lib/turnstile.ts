import type { Env } from "../env";

/** Verify Cloudflare Turnstile when TURNSTILE_SECRET_KEY is configured. */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip: string | null,
): Promise<boolean> {
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
