import { errorJson } from "./http";

/**
 * Validates the `Origin` header against `APP_ORIGIN` when present.
 *
 * - **Missing Origin:** allowed (curl, wrangler, integration scripts, same-site
 *   navigations that do not send Origin on cookie POSTs are rare; browsers send
 *   Origin on cross-site and credentialed fetches).
 * - **Present Origin:** must equal `new URL(APP_ORIGIN).origin` exactly.
 * - **Browser WebSocket upgrades:** always include Origin; mismatches are rejected.
 *
 * Apply to cookie-authenticated POST `/api/*` and `/ws/*` upgrades in the Worker entry.
 */
export function rejectDisallowedOrigin(
  request: Request,
  appOrigin: string,
): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;

  let expected: string;
  try {
    expected = new URL(appOrigin).origin;
  } catch {
    return errorJson(403, "Origin not allowed.");
  }

  if (origin !== expected) {
    return errorJson(403, "Origin not allowed.");
  }
  return null;
}

/** POST APIs and WebSocket upgrades that carry session cookies. */
export function requiresOriginCheck(request: Request, pathname: string): boolean {
  if (pathname.match(/^\/ws\/rooms\/[^/]+$/)) return true;
  if (request.method === "POST" && pathname.startsWith("/api/")) return true;
  return false;
}
