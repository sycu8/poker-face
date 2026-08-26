export type SeatVoiceStatus = {
  muted: boolean;
  speaking: boolean;
};

export type VoicePeerSnapshot = {
  customParticipantId: string;
  audioEnabled: boolean;
  speaking: boolean;
};

/** Build seat → mute/speaking map keyed by app user id (RealtimeKit customParticipantId). */
export function buildSeatVoiceStatuses(
  peers: VoicePeerSnapshot[],
): Record<string, SeatVoiceStatus> {
  const out: Record<string, SeatVoiceStatus> = {};
  for (const peer of peers) {
    const id = peer.customParticipantId.trim();
    if (!id) continue;
    const muted = !peer.audioEnabled;
    out[id] = {
      muted,
      speaking: !muted && peer.speaking,
    };
  }
  return out;
}

/** Frequency-bin average threshold for “is speaking” (0–255 scale). */
export const SPEAKING_LEVEL_THRESHOLD = 16;
