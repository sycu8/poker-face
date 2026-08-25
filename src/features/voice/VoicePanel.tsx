import { useEffect, useRef, useState } from "react";
import { useRealtimeKitClient } from "@cloudflare/realtimekit-react";
import { api, type VoiceTokenResponse } from "../../lib/api";

/**
 * Optional voice via RealtimeKit. Game actions never depend on this panel.
 */
export function VoicePanel({ roomId }: { roomId: string }) {
  const [meeting, initMeeting] = useRealtimeKitClient();
  const meetingRef = useRef<typeof meeting | undefined>(meeting);
  const [message, setMessage] = useState(
    "Optional voice — the table keeps playing either way.",
  );
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    meetingRef.current = meeting;
  }, [meeting]);

  useEffect(() => {
    return () => {
      try {
        void meetingRef.current?.leave?.();
      } catch {
        /* ignore */
      }
    };
  }, []);

  async function connectVoice() {
    setBusy(true);
    setMessage("Connecting voice…");
    try {
      const res: VoiceTokenResponse = await api.voiceToken(roomId);
      if (!res.available || !res.token) {
        setJoined(false);
        setMessage(
          res.message ??
            (res.reason === "not_configured"
              ? "Voice isn’t configured on this deployment. The game stays connected."
              : "Voice isn’t available here. Chat still works."),
        );
        return;
      }

      // Start muted; players unmute when ready.
      const client = await initMeeting({
        authToken: res.token,
        defaults: { audio: false, video: false },
      });
      if (!client) {
        setMessage("Voice SDK failed to start. The game is still connected.");
        return;
      }
      await client.join();
      meetingRef.current = client;
      setMuted(true);
      setJoined(true);
      setMessage("Voice connected. Unmute when you’re ready — cards never depend on voice.");
    } catch (err) {
      setJoined(false);
      setMessage(
        err instanceof Error
          ? `${err.message} The game is still connected.`
          : "Voice is unavailable right now. The game is still connected.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleMute() {
    const self = meetingRef.current?.self ?? meeting?.self;
    if (!self) return;
    try {
      if (muted) {
        await self.enableAudio();
        setMuted(false);
        setMessage("Mic on.");
      } else {
        await self.disableAudio();
        setMuted(true);
        setMessage("Mic muted.");
      }
    } catch {
      setMessage("Could not toggle mic. Check browser microphone permission.");
    }
  }

  async function leaveVoice() {
    try {
      await (meetingRef.current ?? meeting)?.leave?.();
    } catch {
      /* ignore */
    }
    meetingRef.current = undefined;
    setJoined(false);
    setMuted(true);
    setMessage("Left voice. The table is still connected.");
  }

  return (
    <div className="panel">
      <strong>Voice</strong>
      <p className="muted">{message}</p>
      <div className="cta-row">
        {!joined ? (
          <button
            className="btn btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => void connectVoice()}
          >
            {busy ? "Connecting…" : "Enable voice"}
          </button>
        ) : (
          <>
            <button className="btn btn-secondary" type="button" onClick={() => void toggleMute()}>
              {muted ? "Unmute" : "Mute"}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => void leaveVoice()}>
              Leave voice
            </button>
          </>
        )}
      </div>
    </div>
  );
}
