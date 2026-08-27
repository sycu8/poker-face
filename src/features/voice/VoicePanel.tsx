import { useVoiceControls } from "./voiceContext";

/**
 * Optional voice via RealtimeKit. Game actions never depend on this panel.
 * Must render under VoiceSessionProvider.
 */
export function VoicePanel() {
  const voice = useVoiceControls();
  if (!voice) return null;

  const { busy, joined, muted, message, connectVoice, toggleMute, leaveVoice } = voice;

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
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => void toggleMute()}
            >
              {muted ? "Unmute" : "Mute"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => void leaveVoice()}
            >
              Leave voice
            </button>
          </>
        )}
      </div>
    </div>
  );
}
