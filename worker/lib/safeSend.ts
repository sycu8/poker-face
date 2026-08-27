/**
 * Best-effort WebSocket send. Never throws into authoritative game paths.
 * Returns false when the socket is broken (optionally closed).
 */
export function safeSend(ws: { send: (data: string) => void; close?: (code?: number, reason?: string) => void }, data: string): boolean {
  try {
    ws.send(data);
    return true;
  } catch {
    try {
      ws.close?.(1011, "send_failed");
    } catch {
      /* ignore */
    }
    return false;
  }
}
