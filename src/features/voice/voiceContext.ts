import { createContext, useContext } from "react";
import type { SeatVoiceStatus } from "./voiceStatus";

export type VoiceControls = {
  roomId: string;
  joined: boolean;
  muted: boolean;
  busy: boolean;
  message: string;
  connectVoice: () => Promise<void>;
  toggleMute: () => Promise<void>;
  leaveVoice: () => Promise<void>;
};

export const VoiceControlsContext = createContext<VoiceControls | null>(null);
export const VoiceStatusContext = createContext<Record<string, SeatVoiceStatus>>({});

export function useVoiceControls(): VoiceControls | null {
  return useContext(VoiceControlsContext);
}

export function useSeatVoiceStatus(playerId: string | null | undefined): SeatVoiceStatus | null {
  const map = useContext(VoiceStatusContext);
  if (!playerId) return null;
  return map[playerId] ?? null;
}
