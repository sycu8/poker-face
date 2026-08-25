import { useState } from "react";
import { api } from "../../lib/api";

/**
 * Voice uses RealtimeKit when configured. Game actions never depend on this panel.
 */
export function VoicePanel({ roomId }: { roomId: string }) {
  const [message, setMessage] = useState("Voice stays optional.");
  const [muted, setMuted] = useState(true);
  const [available, setAvailable] = useState<boolean | null>(null);

  async function connectVoice() {
    try {
      const res = await api.voiceToken(roomId);
      setAvailable(res.available);
      if (!res.available) {
        setMessage(res.message ?? "Voice is unavailable. The game is still connected.");
        return;
      }
      setMessage("Voice token ready. Join with RealtimeKit Core when the SDK is initialized.");
      setMuted(false);
      // Full RealtimeKit client join is enabled when REALTIMEKIT_* secrets exist.
      // We intentionally keep game path independent of voice success/failure.
    } catch {
      setAvailable(false);
      setMessage("Voice is unavailable. The game is still connected.");
    }
  }

  return (
    <div className="panel">
      <strong>Voice</strong>
      <p className="muted">{message}</p>
      <div className="cta-row">
        <button className="btn btn-secondary" type="button" onClick={() => void connectVoice()}>
          {available ? "Refresh voice" : "Voice on"}
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => setMuted((m) => !m)}>
          {muted ? "Unmute" : "Mute"}
        </button>
      </div>
    </div>
  );
}
