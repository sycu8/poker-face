import type { Env } from "./env";
import { handleAuth } from "./auth/passwordAuth";
import { handleRooms } from "./routes/rooms";
import { handleVoice } from "./voice/realtimekit";
import { requireUser } from "./auth/session";
import { readPublicConfig } from "./lib/configKv";
import { requireActiveMember } from "./lib/membership";
import { errorJson, json } from "./lib/http";
import { RoomDurableObject } from "./room/RoomDurableObject";

export { RoomDurableObject };

const SECURITY_HEADERS: Record<string, string> = {
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
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' https: wss:",
    "frame-src https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
  ].join("; "),
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleArchiveBatch(
  batch: MessageBatch,
  env: Env,
): Promise<void> {
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

    if (request.method === "OPTIONS") {
      return withSecurityHeaders(
        new Response(null, {
          headers: {
            "access-control-allow-origin": env.APP_ORIGIN,
            "access-control-allow-credentials": "true",
            "access-control-allow-headers":
              "content-type, authorization, x-idempotency-key",
            "access-control-allow-methods": "GET,POST,OPTIONS",
          },
        }),
      );
    }

    if (url.pathname === "/api/health") {
      return withSecurityHeaders(
        json({
          ok: true,
          service: "poker-faces",
          environment: env.ENVIRONMENT,
          tagline: "Your table. Your people.",
        }),
      );
    }

    if (url.pathname === "/api/config") {
      const cfg = await readPublicConfig(env);
      return withSecurityHeaders(json(cfg));
    }

    const authRes = await handleAuth(request, env, url.pathname);
    if (authRes) return withSecurityHeaders(authRes);

    const roomsRes = await handleRooms(request, env, url.pathname);
    if (roomsRes) return withSecurityHeaders(roomsRes);

    const voiceRes = await handleVoice(request, env, url.pathname);
    if (voiceRes) return withSecurityHeaders(voiceRes);

    const wsMatch = url.pathname.match(/^\/ws\/rooms\/([^/]+)$/);
    if (wsMatch) {
      const auth = await requireUser(env, request);
      if (!auth.ok) return withSecurityHeaders(errorJson(auth.status, auth.error));
      const roomId = wsMatch[1]!;
      const member = await requireActiveMember(env, roomId, auth.user.id);
      if (!member.ok) {
        return withSecurityHeaders(errorJson(403, "Ask to join this table first."));
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
      const doUrl = new URL("https://room/ws");
      doUrl.searchParams.set("userId", auth.user.id);
      doUrl.searchParams.set("displayName", auth.user.displayName);
      return stub.fetch(doUrl, request);
    }

    if (url.pathname.startsWith("/api/")) {
      return withSecurityHeaders(errorJson(404, "Not found."));
    }

    const assetRes = await env.ASSETS.fetch(request);
    return withSecurityHeaders(assetRes);
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await handleArchiveBatch(batch, env);
  },
} satisfies ExportedHandler<Env>;
