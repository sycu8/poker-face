import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  RealtimeKitProvider,
  useRealtimeKitClient,
} from "@cloudflare/realtimekit-react";
import type RealtimeKitClient from "@cloudflare/realtimekit";
import { api, type VoiceTokenResponse } from "../../lib/api";
import {
  VoiceControlsContext,
  VoiceStatusContext,
  type VoiceControls,
} from "./voiceContext";
import {
  buildSeatVoiceStatuses,
  SPEAKING_LEVEL_THRESHOLD,
  type SeatVoiceStatus,
} from "./voiceStatus";

type PeerRow = {
  peerId: string;
  customParticipantId: string;
  audioEnabled: boolean;
};

function listPeers(meeting: RealtimeKitClient): PeerRow[] {
  const rows: PeerRow[] = [];
  const self = meeting.self;
  if (self?.customParticipantId) {
    rows.push({
      peerId: self.id,
      customParticipantId: self.customParticipantId,
      audioEnabled: Boolean(self.audioEnabled),
    });
  }
  try {
    for (const p of meeting.participants?.joined?.toArray?.() ?? []) {
      if (!p?.customParticipantId) continue;
      rows.push({
        peerId: p.id,
        customParticipantId: p.customParticipantId,
        audioEnabled: Boolean(p.audioEnabled),
      });
    }
  } catch {
    /* mid-teardown */
  }
  return rows;
}

function VoiceStatusSync({
  meeting,
  active,
  children,
}: {
  meeting: RealtimeKitClient | undefined;
  active: boolean;
  children: ReactNode;
}) {
  const [statuses, setStatuses] = useState<Record<string, SeatVoiceStatus>>({});
  const speakingPeerIds = useRef(new Set<string>());
  const decayTimers = useRef(new Map<string, number>());
  const selfMeterCleanup = useRef<(() => void) | null>(null);

  const publish = useCallback((meetingClient: RealtimeKitClient) => {
    const peers = listPeers(meetingClient);
    setStatuses(
      buildSeatVoiceStatuses(
        peers.map((p) => ({
          customParticipantId: p.customParticipantId,
          audioEnabled: p.audioEnabled,
          speaking: speakingPeerIds.current.has(p.peerId),
        })),
      ),
    );
  }, []);

  useEffect(() => {
    const timers = decayTimers.current;
    if (!meeting || !active) {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
      speakingPeerIds.current.clear();
      selfMeterCleanup.current?.();
      selfMeterCleanup.current = null;
      setStatuses({});
      return;
    }

    const markSpeaking = (peerId: string, speaking: boolean, decayMs = 550) => {
      if (speaking) {
        speakingPeerIds.current.add(peerId);
        const prev = timers.get(peerId);
        if (prev) window.clearTimeout(prev);
        timers.set(
          peerId,
          window.setTimeout(() => {
            speakingPeerIds.current.delete(peerId);
            timers.delete(peerId);
            publish(meeting);
          }, decayMs),
        );
      } else {
        speakingPeerIds.current.delete(peerId);
        const prev = timers.get(peerId);
        if (prev) window.clearTimeout(prev);
        timers.delete(peerId);
      }
      publish(meeting);
    };

    const onActiveSpeaker = (payload: { peerId: string; volume: number }) => {
      markSpeaking(payload.peerId, payload.volume > 0);
    };

    const attachSelfMeter = () => {
      selfMeterCleanup.current?.();
      selfMeterCleanup.current = null;
      const self = meeting.self;
      if (!self?.audioEnabled || !self.audioTrack) {
        if (self?.id) markSpeaking(self.id, false);
        return;
      }
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      let cancelled = false;
      let raf = 0;
      let ctx: AudioContext | null = null;
      try {
        ctx = new Ctx();
        const source = ctx.createMediaStreamSource(new MediaStream([self.audioTrack]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);
        const bins = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (cancelled) return;
          analyser.getByteFrequencyData(bins);
          let sum = 0;
          for (let i = 0; i < bins.length; i++) sum += bins[i]!;
          const next = sum / bins.length >= SPEAKING_LEVEL_THRESHOLD;
          const was = speakingPeerIds.current.has(self.id);
          if (next !== was) {
            markSpeaking(self.id, next, 200);
          } else if (next) {
            const prev = timers.get(self.id);
            if (prev) window.clearTimeout(prev);
            timers.set(
              self.id,
              window.setTimeout(() => {
                speakingPeerIds.current.delete(self.id);
                timers.delete(self.id);
                publish(meeting);
              }, 200),
            );
          }
          raf = requestAnimationFrame(tick);
        };
        void ctx.resume().then(() => {
          if (!cancelled) raf = requestAnimationFrame(tick);
        });
      } catch {
        return;
      }
      selfMeterCleanup.current = () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        void ctx?.close();
      };
    };

    const onRoster = () => {
      publish(meeting);
      attachSelfMeter();
    };

    publish(meeting);
    attachSelfMeter();

    try {
      meeting.participants.on("activeSpeaker", onActiveSpeaker);
      meeting.participants.joined.on("participantJoined", onRoster);
      meeting.participants.joined.on("participantLeft", onRoster);
      meeting.self.on("audioUpdate", onRoster);
    } catch {
      /* ignore */
    }

    const poll = window.setInterval(() => publish(meeting), 500);

    return () => {
      window.clearInterval(poll);
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
      selfMeterCleanup.current?.();
      selfMeterCleanup.current = null;
      try {
        meeting.participants.off("activeSpeaker", onActiveSpeaker);
        meeting.participants.joined.off("participantJoined", onRoster);
        meeting.participants.joined.off("participantLeft", onRoster);
        meeting.self.off("audioUpdate", onRoster);
      } catch {
        /* ignore */
      }
    };
  }, [meeting, active, publish]);

  return (
    <VoiceStatusContext.Provider value={statuses}>{children}</VoiceStatusContext.Provider>
  );
}

export function VoiceSessionProvider({
  roomId,
  children,
}: {
  roomId: string;
  children: ReactNode;
}) {
  const [meeting, initMeeting] = useRealtimeKitClient();
  const meetingRef = useRef<RealtimeKitClient | undefined>(meeting);
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

  const connectVoice = useCallback(async () => {
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
  }, [initMeeting, roomId]);

  const toggleMute = useCallback(async () => {
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
  }, [meeting, muted]);

  const leaveVoice = useCallback(async () => {
    try {
      await (meetingRef.current ?? meeting)?.leave?.();
    } catch {
      /* ignore */
    }
    meetingRef.current = undefined;
    setJoined(false);
    setMuted(true);
    setMessage("Left voice. The table is still connected.");
  }, [meeting]);

  const controls = useMemo<VoiceControls>(
    () => ({
      roomId,
      joined,
      muted,
      busy,
      message,
      connectVoice,
      toggleMute,
      leaveVoice,
    }),
    [roomId, joined, muted, busy, message, connectVoice, toggleMute, leaveVoice],
  );

  return (
    <RealtimeKitProvider value={meeting}>
      <VoiceControlsContext.Provider value={controls}>
        <VoiceStatusSync meeting={meeting} active={joined}>
          {children}
        </VoiceStatusSync>
      </VoiceControlsContext.Provider>
    </RealtimeKitProvider>
  );
}
