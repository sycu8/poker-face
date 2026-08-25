import { useState } from "react";
import { api } from "../../lib/api";

/**
 * Voice uses RealtimeKit when configured. Game actions never depend on this panel.
 */
export function VoicePanel({ roomId }: { roomId: string }) {
  const [message, setMessage] = useState(
    "Optional voice — the table keeps playing either way.",
  );
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  async function connectVoice() {
    setBusy(true);
    try {
      const res = await api.voiceToken(roomId);
      setAvailable(res.available);
      if (!res.available) {
        setMessage(res.message ?? "Voice isn’t configured here. Keep playing — chat still works.");
        return;
      }
      setMessage(
        "Voice is provisioned for this table. Full RealtimeKit join ships when the client SDK is wired; your cards and actions stay independent of voice.",
      );
    } catch {
      setAvailable(false);
      setMessage("Voice is unavailable right now. The game is still connected.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <strong>Voice</strong>
      <p className="muted">{message}</p>
      <div className="panel-actions">
        <button
          className="btn btn-secondary"
          type="button"
          disabled={busy}
          onClick={() => void connectVoice()}
        >
          {busy ? "Checking…" : available ? "Refresh voice" : "Enable voice"}
        </button>
      </div>
    </div>
  );
}
