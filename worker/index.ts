import type { Env } from "./env";
import { handleAuth } from "./auth/webauthn";
import { handleRooms } from "./routes/rooms";
import { handleVoice } from "./voice/realtimekit";
import { requireUser } from "./auth/session";
import { errorJson, json } from "./lib/http";
import { RoomDurableObject } from "./room/RoomDurableObject";

export { RoomDurableObject };

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
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": env.APP_ORIGIN,
          "access-control-allow-credentials": "true",
          "access-control-allow-headers":
            "content-type, authorization, x-idempotency-key",
          "access-control-allow-methods": "GET,POST,OPTIONS",
        },
      });
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "poker-faces",
        environment: env.ENVIRONMENT,
        tagline: "Your table. Your people.",
      });
    }

    if (url.pathname === "/api/config") {
      return json({
        turnstileSiteKey: env.TURNSTILE_SITE_KEY,
        environment: env.ENVIRONMENT,
        appOrigin: env.APP_ORIGIN,
        copy: {
          tagline: "Your table. Your people.",
          support: "Private poker nights, wherever everyone is.",
          chips: "Virtual chips only. No purchases or cash-out.",
        },
      });
    }

    const authRes = await handleAuth(request, env, url.pathname);
    if (authRes) return authRes;

    const roomsRes = await handleRooms(request, env, url.pathname);
    if (roomsRes) return roomsRes;

    const voiceRes = await handleVoice(request, env, url.pathname);
    if (voiceRes) return voiceRes;

    const wsMatch = url.pathname.match(/^\/ws\/rooms\/([^/]+)$/);
    if (wsMatch) {
      const auth = await requireUser(env, request);
      if (!auth.ok) return errorJson(auth.status, auth.error);
      const roomId = wsMatch[1]!;
      const member = await env.DB.prepare(
        `SELECT * FROM room_members WHERE room_id = ? AND user_id = ?`,
      )
        .bind(roomId, auth.user.id)
        .first();
      if (!member) return errorJson(403, "Ask to join this table first.");
      const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
      const doUrl = new URL("https://room/ws");
      doUrl.searchParams.set("userId", auth.user.id);
      doUrl.searchParams.set("displayName", auth.user.displayName);
      return stub.fetch(doUrl, request);
    }

    if (url.pathname.startsWith("/api/")) {
      return errorJson(404, "Not found.");
    }

    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await handleArchiveBatch(batch, env);
  },
} satisfies ExportedHandler<Env>;
