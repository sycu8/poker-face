import { useSeatVoiceStatus } from "./voiceContext";

/**
 * Mute / speaking mic beside a seat name tag.
 * Hidden when that player is not in the voice session.
 */
export function SeatMicIndicator({ playerId }: { playerId: string | null }) {
  const status = useSeatVoiceStatus(playerId);
  if (!status) return null;

  const label = status.muted ? "Muted" : status.speaking ? "Speaking" : "Mic on";
  const stateClass = status.muted
    ? "seat-mic--muted"
    : status.speaking
      ? "seat-mic--speaking"
      : "seat-mic--live";

  return (
    <span className={`seat-mic ${stateClass}`} title={label} aria-label={label} role="img">
      {status.muted ? (
        <svg className="seat-mic-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M19.1 17.7 6.3 4.9 5 6.2l3.4 3.4V12a3.6 3.6 0 0 0 5.5 3.1l1.1 1.1A5 5 0 0 1 7 12H5a7 7 0 0 0 6 6.9V21h2v-2.1a6.9 6.9 0 0 0 3.2-1.4l2.7 2.7 1.2-1.5ZM12 14.5A2.5 2.5 0 0 1 9.5 12v-.3l3.7 3.7c-.4.07-.8.1-1.2.1Zm0-11a3.5 3.5 0 0 0-3.5 3.5v.8l7 7V7A3.5 3.5 0 0 0 12 3.5Z"
          />
        </svg>
      ) : (
        <>
          <svg className="seat-mic-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 14a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 1 0-7 0v5A3.5 3.5 0 0 0 12 14Zm5-3.5a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1a7 7 0 0 0 6-6.9h-2Z"
            />
          </svg>
          <span className="seat-mic-bars" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </>
      )}
    </span>
  );
}
