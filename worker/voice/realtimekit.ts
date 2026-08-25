import type { Env } from "../env";
import { errorJson, json } from "../lib/http";
import { requireUser } from "../auth/session";

/**
 * RealtimeKit voice provisioning. Degraded mode: if credentials are missing,
 * return a structured unavailable payload so the game continues.
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
  if (!member) return errorJson(403, "You need a seat before joining voice.");

  if (!env.REALTIMEKIT_APP_ID || !env.REALTIMEKIT_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return json({
      available: false,
      message: "Voice is unavailable. The game is still connected.",
    });
  }

  const room = await env.DB.prepare(`SELECT * FROM rooms WHERE id = ?`)
    .bind(roomId)
    .first<{ id: string; realtimekit_meeting_id: string | null; name: string }>();
  if (!room) return errorJson(404, "Table not found.");

  let meetingId = room.realtimekit_meeting_id;
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`;

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
      const body = (await created.json()) as {
        success?: boolean;
        result?: { id?: string; data?: { id?: string } };
      };
      meetingId = body.result?.id ?? body.result?.data?.id ?? null;
      if (!meetingId) {
        return json({
          available: false,
          message: "Voice is unavailable. The game is still connected.",
        });
      }
      await env.DB.prepare(
        `UPDATE rooms SET realtimekit_meeting_id = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(meetingId, Date.now(), roomId)
        .run();
    }

    // Opaque participant id — do not put PII in custom_participant_id
    const customParticipantId = await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(`${roomId}:${auth.user.id}`))
      .then((buf) =>
        [...new Uint8Array(buf)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 32),
      );

    const participantRes = await fetch(`${base}/meetings/${meetingId}/participants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.REALTIMEKIT_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: auth.user.displayName,
        preset_name: "voice",
        custom_participant_id: customParticipantId,
      }),
    });
    const participantBody = (await participantRes.json()) as {
      success?: boolean;
      result?: { token?: string; data?: { token?: string } };
    };
    const token =
      participantBody.result?.token ?? participantBody.result?.data?.token ?? null;
    if (!token) {
      return json({
        available: false,
        message: "Voice is unavailable. The game is still connected.",
      });
    }
    return json({ available: true, token, meetingId });
  } catch {
    return json({
      available: false,
      message: "Voice is unavailable. The game is still connected.",
    });
  }
}
