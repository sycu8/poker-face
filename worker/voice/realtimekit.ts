import type { Env } from "../env";
import { errorJson, json } from "../lib/http";
import { requireUser } from "../auth/session";

/** Default RealtimeKit preset — must exist on the app (override with REALTIMEKIT_PRESET_NAME). */
export const DEFAULT_REALTIMEKIT_PRESET = "group_call_participant";

/** Pull a string id from common RealtimeKit / Cloudflare API envelope shapes. */
export function extractRealtimeId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const candidates: unknown[] = [
    root.id,
    root.meetingId,
    (root.result as Record<string, unknown> | undefined)?.id,
    (root.result as Record<string, unknown> | undefined)?.meetingId,
    ((root.result as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)
      ?.id,
    ((root.result as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)
      ?.meetingId,
    (root.data as Record<string, unknown> | undefined)?.id,
    (root.data as Record<string, unknown> | undefined)?.meetingId,
    ((root.data as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

/** Pull participant auth token from common envelope shapes. */
export function extractRealtimeToken(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const candidates: unknown[] = [
    root.token,
    root.authToken,
    (root.result as Record<string, unknown> | undefined)?.token,
    (root.result as Record<string, unknown> | undefined)?.authToken,
    ((root.result as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)
      ?.token,
    ((root.result as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)
      ?.authToken,
    (root.data as Record<string, unknown> | undefined)?.token,
    (root.data as Record<string, unknown> | undefined)?.authToken,
    ((root.data as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)
      ?.token,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

function apiErrorDetail(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const root = body as Record<string, unknown>;
    const errors = root.errors;
    if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") {
      const msg = (errors[0] as { message?: string }).message;
      if (msg) return msg;
    }
    const message = root.message;
    if (typeof message === "string" && message) return message;
  }
  return `HTTP ${status}`;
}

/**
 * RealtimeKit voice provisioning. Degraded mode: if credentials are missing,
 * return a structured unavailable payload so the game continues.
 *
 * Requires Worker secrets: REALTIMEKIT_APP_ID, REALTIMEKIT_API_TOKEN (Realtime Admin
 * Cloudflare token), CLOUDFLARE_ACCOUNT_ID. Calls TURN keys are separate — the client
 * gets media connectivity via the participant token; see docs/VOICE_SETUP.md.
 */
export async function handleVoice(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const match = path.match(/^\/api\/rooms\/([^/]+)\/voice-token$/);
  if (!match || request.method !== "POST") return null;

  const auth = await requireUser(env, request);
  if (!auth.ok) return errorJson(auth.status, auth.error);
  const roomId = match[1]!;

  const member = await env.DB.prepare(
    `SELECT * FROM room_members WHERE room_id = ? AND user_id = ? AND status = 'seated'`,
  )
    .bind(roomId, auth.user.id)
    .first();
  if (!member) {
    return errorJson(403, "You need an approved seat before joining voice.");
  }

  const missing: string[] = [];
  if (!env.REALTIMEKIT_APP_ID) missing.push("REALTIMEKIT_APP_ID");
  if (!env.REALTIMEKIT_API_TOKEN) missing.push("REALTIMEKIT_API_TOKEN");
  if (!env.CLOUDFLARE_ACCOUNT_ID) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (missing.length) {
    console.error("voice not configured", missing.join(","));
    return json({
      available: false,
      reason: "not_configured",
      message:
        "Voice isn’t configured on this deployment. The game stays connected.",
    });
  }

  const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`)
    .bind(roomId)
    .first<{ id: string; realtimekit_meeting_id: string | null; name: string }>();
  if (!room) return errorJson(404, "Table not found.");

  let meetingId = room.realtimekit_meeting_id;
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`;
  const presetName = env.REALTIMEKIT_PRESET_NAME || DEFAULT_REALTIMEKIT_PRESET;

  try {
    if (!meetingId) {
      const created = await fetch(`${base}/meetings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.REALTIMEKIT_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: room.name }),
      });
      const body: unknown = await created.json();
      meetingId = extractRealtimeId(body);
      if (!meetingId) {
        console.error("voice meeting create failed", apiErrorDetail(body, created.status));
        return json({
          available: false,
          reason: "meeting_create_failed",
          message: "Could not create a voice room. The game is still connected.",
        });
      }
      await env.DB.prepare(
        `UPDATE rooms SET realtimekit_meeting_id = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(meetingId, Date.now(), roomId)
        .run();
    }

    // App user id maps seats → mute/speaking indicators (not PII).
    const customParticipantId = auth.user.id;

    const participantRes = await fetch(`${base}/meetings/${meetingId}/participants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.REALTIMEKIT_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: auth.user.displayName,
        preset_name: presetName,
        custom_participant_id: customParticipantId,
      }),
    });
    const participantBody: unknown = await participantRes.json();
    const token = extractRealtimeToken(participantBody);
    if (!token) {
      return json({
        available: false,
        reason: "participant_failed",
        message:
          "Could not join voice. Check RealtimeKit configuration. The game is still connected.",
      });
    }
    return json({ available: true, token, meetingId });
  } catch (err) {
    console.error("voice-token failed", err instanceof Error ? err.message : err);
    return json({
      available: false,
      reason: "exception",
      message: "Voice failed. The game is still connected.",
    });
  }
}
