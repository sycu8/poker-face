import { useCallback, useEffect, useRef, useState } from "react";

export type RoomConnectionState = "live" | "reconnecting" | "offline";

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

function nextBackoffMs(attempt: number): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 15_000;
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

export interface UseRoomSocketOptions {
  roomId: string;
  /** When false, socket stays closed (e.g. access not yet member). */
  enabled: boolean;
  onMessage: (data: unknown) => void;
  /** Optional: refresh membership before retrying a reconnect. Return false to stop. */
  beforeReconnect?: () => Promise<boolean>;
}

export interface UseRoomSocketResult {
  connectionState: RoomConnectionState;
  /** False while reconnecting until a fresh snapshot arrives; also false when offline. */
  actionsEnabled: boolean;
  send: (payload: unknown) => void;
  /** Close without scheduling reconnect (table closed, leave, etc.). */
  disconnect: () => void;
}

/**
 * Room WebSocket lifecycle: connect, exponential backoff reconnect, dispose-safe teardown.
 * Closing while disposed/unmounted or via intentionalClose never schedules reconnect.
 */
export function useRoomSocket({
  roomId,
  enabled,
  onMessage,
  beforeReconnect,
}: UseRoomSocketOptions): UseRoomSocketResult {
  const [connectionState, setConnectionState] = useState<RoomConnectionState>("offline");
  const [actionsEnabled, setActionsEnabled] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const socketGenRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const disposedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  /** After a drop, withhold actions until the next snapshot. */
  const awaitingSnapshotRef = useRef(false);

  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const beforeReconnectRef = useRef(beforeReconnect);
  beforeReconnectRef.current = beforeReconnect;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    socketGenRef.current += 1;
    clearReconnectTimer();
    awaitingSnapshotRef.current = false;
    setActionsEnabled(false);
    setConnectionState("offline");
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
  }, [clearReconnectTimer]);

  const connectRef = useRef<() => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (disposedRef.current || intentionalCloseRef.current) return;
    clearReconnectTimer();
    setConnectionState("reconnecting");
    setActionsEnabled(false);
    awaitingSnapshotRef.current = true;
    const attempt = reconnectAttemptRef.current;
    const delay = nextBackoffMs(attempt);
    reconnectAttemptRef.current = attempt + 1;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (disposedRef.current || intentionalCloseRef.current) return;
      void (async () => {
        if (beforeReconnectRef.current) {
          try {
            const ok = await beforeReconnectRef.current();
            if (!ok || disposedRef.current || intentionalCloseRef.current) return;
          } catch {
            if (disposedRef.current || intentionalCloseRef.current) return;
            scheduleReconnect();
            return;
          }
        }
        if (disposedRef.current || intentionalCloseRef.current) return;
        connectRef.current();
      })();
    }, delay);
  }, [clearReconnectTimer]);

  const connect = useCallback(() => {
    if (disposedRef.current || !roomId) return;
    clearReconnectTimer();
    intentionalCloseRef.current = false;

    const gen = ++socketGenRef.current;
    const existing = wsRef.current;
    if (existing) {
      wsRef.current = null;
      try {
        existing.close();
      } catch {
        /* ignore */
      }
    }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/rooms/${roomId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (disposedRef.current || gen !== socketGenRef.current) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      reconnectAttemptRef.current = 0;
      setConnectionState("live");
      // Actions stay gated until a snapshot (fresh on reconnect; first paint on connect).
    };

    ws.onclose = () => {
      if (gen !== socketGenRef.current) return;
      if (wsRef.current === ws) wsRef.current = null;
      if (disposedRef.current || intentionalCloseRef.current) {
        setConnectionState("offline");
        setActionsEnabled(false);
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose handles reconnect; avoid double-scheduling here.
    };

    ws.onmessage = (ev) => {
      if (disposedRef.current || gen !== socketGenRef.current) return;
      let data: unknown;
      try {
        data = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      const msg = data as { type?: string };
      if (msg.type === "snapshot") {
        awaitingSnapshotRef.current = false;
        setActionsEnabled(true);
        setConnectionState("live");
        reconnectAttemptRef.current = 0;
      }
      onMessageRef.current(data);
    };
  }, [roomId, clearReconnectTimer, scheduleReconnect]);

  connectRef.current = connect;

  const send = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    if (!enabled || !roomId) {
      intentionalCloseRef.current = true;
      socketGenRef.current += 1;
      clearReconnectTimer();
      awaitingSnapshotRef.current = false;
      setActionsEnabled(false);
      setConnectionState("offline");
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      return () => {
        disposedRef.current = true;
        clearReconnectTimer();
      };
    }
    connect();
    return () => {
      disposedRef.current = true;
      intentionalCloseRef.current = true;
      socketGenRef.current += 1;
      clearReconnectTimer();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      setConnectionState("offline");
      setActionsEnabled(false);
      awaitingSnapshotRef.current = false;
    };
  }, [enabled, roomId, connect, clearReconnectTimer]);

  return {
    connectionState,
    actionsEnabled,
    send,
    disconnect,
  };
}
