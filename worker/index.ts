import type { Env } from "./env";
import { handleOAuth } from "./auth/oauth";
import { handleAuth } from "./auth/passwordAuth";
import { handleRooms } from "./routes/rooms";
import { handleAdmin } from "./routes/admin";
import { handleVoice } from "./voice/realtimekit";
import { purgeExpiredSessions, requireUser } from "./auth/session";
import { readPublicConfig } from "./lib/configKv";
import { requireActiveMember } from "./lib/membership";
import { flushMembershipOps } from "./lib/membershipOps";
import { errorJson, json } from "./lib/http";
import { rejectDisallowedOrigin, requiresOriginCheck } from "./lib/origin";
import { RoomDurableObject } from "./room/RoomDurableObject";
import {
  discoveryPreflight,
  handleDiscovery,
  isHomepagePath,
  isPublicDiscoveryPath,
} from "./discovery/handle";
import { HOMEPAGE_LINK_HEADER, siteOrigin } from "./discovery/documents";

export { RoomDurableObject };

function securityHeaders(env: Env): Record<string, string> {
  // Vite's dev server injects an inline React refresh preamble. Production
  // bundles have no inline scripts, so that source stays off outside local.
  const scriptSrc =
    env.ENVIRONMENT === "local"
      ? "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com"
      : "script-src 'self' https://challenges.cloudflare.com";
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://cdn.buymeacoffee.com",
      "font-src 'self'",
      "connect-src 'self' https: wss:",
      "frame-src https://challenges.cloudflare.com",
      "worker-src 'self' blob:",
    ].join("; "),
  };
}

function finalizeResponse(response: Response, request: Request, env: Env): Response {
  const url = new URL(request.url);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders(env))) {
    if (!headers.has(key)) headers.set(key, value);
  }
  if (response.status === 200 && isHomepagePath(url.pathname) && !headers.has("Link")) {
    headers.set("Link", HOMEPAGE_LINK_HEADER);
  }
  if (response.status === 401 && !headers.has("WWW-Authenticate")) {
    const origin = siteOrigin(env.APP_ORIGIN, url);
    headers.set(
      "WWW-Authenticate",
      `Bearer realm="poker-faces", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleArchiveBatch(batch: MessageBatch, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const body = msg.body as {
        type: string;
        roomId: string;
        handNumber?: number;
        summary?: unknown;
        idempotencyKey: string;
      };
      const existing = await env.DB.prepare(
        `SELECT key FROM idempotency_keys WHERE scope = 'archive' AND key = ?`,
      )
        .bind(body.idempotencyKey)
        .first();
      if (existing) {
        msg.ack();
        continue;
      }
      if (body.type === "hand_complete" && body.handNumber != null) {
        const id = crypto.randomUUID();
        const summaryJson = JSON.stringify(body.summary ?? {});
        await env.DB.prepare(
          `INSERT OR IGNORE INTO hand_summaries
           (id, room_id, hand_number, sequence_end, summary_json, created_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
        )
          .bind(id, body.roomId, body.handNumber, summaryJson, Date.now())
          .run();
        await env.REPLAY_R2.put(
          `replays/${body.roomId}/hand-${body.handNumber}.json`,
          summaryJson,
          { httpMetadata: { contentType: "application/json" } },
        );
      }
      await env.DB.prepare(
        `INSERT INTO idempotency_keys (scope, key, response_json, created_at)
         VALUES ('archive', ?, '{}', ?)`,
      )
        .bind(body.idempotencyKey, Date.now())
        .run();
      msg.ack();
    } catch {
      msg.retry();
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && isPublicDiscoveryPath(url.pathname)) {
      return finalizeResponse(discoveryPreflight(), request, env);
    }

    if (request.method === "OPTIONS") {
      return finalizeResponse(
        new Response(null, {
          headers: {
            "access-control-allow-origin": env.APP_ORIGIN,
            "access-control-allow-credentials": "true",
            "access-control-allow-headers":
              "content-type, authorization, x-idempotency-key",
            "access-control-allow-methods": "GET,POST,OPTIONS",
          },
        }),
        request,
        env,
      );
    }

    const discovery = await handleDiscovery(request, env.APP_ORIGIN);
    if (discovery) return finalizeResponse(discovery, request, env);

    if (url.pathname === "/api/health") {
      return finalizeResponse(
        json({
          ok: true,
          service: "poker-faces",
          environment: env.ENVIRONMENT,
          tagline: "Your table. Your people.",
        }),
        request,
        env,
      );
    }

    if (requiresOriginCheck(request, url.pathname)) {
      const originReject = rejectDisallowedOrigin(request, env.APP_ORIGIN);
      if (originReject) return finalizeResponse(originReject, request, env);
    }

    if (url.pathname === "/api/config") {
      const cfg = await readPublicConfig(env);
      return finalizeResponse(json(cfg), request, env);
    }

    const authRes = await handleAuth(request, env, url.pathname);
    if (authRes) return finalizeResponse(authRes, request, env);

    const oauthRes = await handleOAuth(request, env, url.pathname);
    if (oauthRes) return finalizeResponse(oauthRes, request, env);

    const adminRes = await handleAdmin(request, env, url.pathname);
    if (adminRes) return finalizeResponse(adminRes, request, env);

    const roomsRes = await handleRooms(request, env, url.pathname);
    if (roomsRes) return finalizeResponse(roomsRes, request, env);

    const voiceRes = await handleVoice(request, env, url.pathname);
    if (voiceRes) return finalizeResponse(voiceRes, request, env);

    const wsMatch = url.pathname.match(/^\/ws\/rooms\/([^/]+)$/);
    if (wsMatch) {
      const auth = await requireUser(env, request);
      if (!auth.ok)
        return finalizeResponse(errorJson(auth.status, auth.error), request, env);
      const roomId = wsMatch[1]!;
      const member = await requireActiveMember(env, roomId, auth.user.id);
      if (!member.ok) {
        return finalizeResponse(
          errorJson(403, "Ask to join this table first."),
          request,
          env,
        );
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
      const doUrl = new URL("https://room/ws");
      doUrl.searchParams.set("userId", auth.user.id);
      doUrl.searchParams.set("displayName", auth.user.displayName);
      return stub.fetch(doUrl, request);
    }

    if (url.pathname.startsWith("/api/")) {
      return finalizeResponse(errorJson(404, "Not found."), request, env);
    }

    const assetRes = await env.ASSETS.fetch(request);
    return finalizeResponse(assetRes, request, env);
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await handleArchiveBatch(batch, env);
  },

  /**
   * Cron: purge expired / old-revoked sessions.
   * Production/staging triggers every 6 hours (see wrangler.jsonc crons).
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    void ctx;
    try {
      const result = await purgeExpiredSessions(env, 100);
      console.log("purgeExpiredSessions", result.deleted);
    } catch (err) {
      console.error(
        "purgeExpiredSessions failed",
        err instanceof Error ? err.message : err,
      );
    }
    try {
      const applied = await flushMembershipOps(env);
      if (applied > 0) console.log("flushMembershipOps", applied);
    } catch (err) {
      console.error(
        "flushMembershipOps failed",
        err instanceof Error ? err.message : err,
      );
    }
  },
} satisfies ExportedHandler<Env>;
