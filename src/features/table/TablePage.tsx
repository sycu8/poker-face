import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type User } from "../../lib/api";
import { VoicePanel } from "../voice/VoicePanel";

interface SeatView {
  seatIndex: number;
  playerId: string | null;
  displayName: string | null;
  stack: number;
  status: string;
  betThisStreet: number;
  holeCards: [string, string] | null;
  isViewer: boolean;
}

interface GameView {
  street: string;
  board: string[];
  pot: number;
  sequence: number;
  actionSeat: number | null;
  turnDeadlineMs: number | null;
  seats: SeatView[];
  legalActions: {
    canFold: boolean;
    canCheck: boolean;
    canCall: boolean;
    callAmount: number;
    canBet: boolean;
    canRaise: boolean;
    minBet: number;
    maxBet: number;
    minRaiseTo: number;
    maxRaiseTo: number;
    canAllIn: boolean;
  } | null;
  config: { smallBlind: number; bigBlind: number };
}

interface ChatMessage {
  id: string;
  displayName: string;
  text: string;
}

export function TablePage({ user }: { user: User }) {
  const { roomId = "" } = useParams();
  const [view, setView] = useState<GameView | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [pendingJoins, setPendingJoins] = useState<
    Array<{ requestId: string; userId: string; displayName: string }>
  >([]);
  const [status, setStatus] = useState("Connecting…");
  const [chatText, setChatText] = useState("");
  const [raiseTo, setRaiseTo] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/rooms/${roomId}`);
    wsRef.current = ws;
    ws.onopen = () => setStatus("Connected");
    ws.onclose = () => {
      setStatus("Rejoining your seat…");
      setTimeout(connect, 1200);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as {
        type: string;
        view?: GameView;
        chat?: ChatMessage[];
        pendingJoins?: typeof pendingJoins;
        message?: ChatMessage;
        error?: string;
      };
      if (msg.type === "snapshot" && msg.view) {
        setView(msg.view);
        if (msg.chat) setChat(msg.chat);
        if (msg.pendingJoins) setPendingJoins(msg.pendingJoins);
        setStatus("The room is yours.");
      }
      if (msg.type === "chat" && msg.message) {
        setChat((c) => [...c, msg.message!]);
      }
      if (msg.type === "error" && msg.error) setStatus(msg.error);
    };
  }, [roomId]);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  const send = (payload: unknown) => {
    wsRef.current?.send(JSON.stringify(payload));
  };

  const legal = view?.legalActions;
  useEffect(() => {
    if (legal?.minRaiseTo) setRaiseTo(legal.minRaiseTo);
    else if (legal?.minBet) setRaiseTo(legal.minBet);
  }, [legal?.minRaiseTo, legal?.minBet]);

  const isHost = useMemo(
    () => view?.seats.some((s) => s.seatIndex === 0 && s.playerId === user.id),
    [view, user.id],
  );

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontFamily: "var(--font-display)", marginBottom: 0 }}>Private table</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            {status} · Blinds {view?.config.smallBlind ?? "–"}/{view?.config.bigBlind ?? "–"} ·{" "}
            <span className="badge">Virtual chips only</span>
          </p>
        </div>
        <div className="cta-row">
          {isHost ? (
            <button className="btn btn-primary" type="button" onClick={() => send({ type: "start_hand" })}>
              Deal everyone in
            </button>
          ) : null}
        </div>
      </div>

      {pendingJoins.length > 0 ? (
        <div className="panel" style={{ marginBottom: "1rem" }}>
          <strong>Join requests</strong>
          {pendingJoins.map((j) => (
            <div
              key={j.requestId}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "0.5rem",
                marginTop: "0.6rem",
                alignItems: "center",
              }}
            >
              <span>{j.displayName} asks to join</span>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() =>
                  void api.decideJoin({
                    requestId: j.requestId,
                    approve: true,
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
              >
                Take a seat
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="table-felt" aria-label="Poker table">
        <div className="board">
          {(view?.board?.length ? view.board : ["?", "?", "?", "?", "?"]).map((c, i) => (
            <div key={`${c}-${i}`} className={c === "?" ? "card back" : "card"} aria-label={c === "?" ? "Hidden card" : c}>
              {c === "?" ? "" : c}
            </div>
          ))}
        </div>
        <div className="pot">Pot {view?.pot ?? 0}</div>
      </div>

      <div className="seats">
        {(view?.seats ?? []).map((seat) => (
          <div
            key={seat.seatIndex}
            className={`seat${view?.actionSeat === seat.seatIndex ? " active-turn" : ""}`}
          >
            <div className="name">{seat.displayName ?? "Open seat"}</div>
            <div className="muted">{seat.status}</div>
            {seat.playerId ? <div className="stack">{seat.stack} chips</div> : null}
            {seat.holeCards ? (
              <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                {seat.holeCards.map((c) => (
                  <div key={c} className="card" style={{ width: 36, height: 52, fontSize: "0.8rem" }}>
                    {c}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {legal ? (
        <div className="actions" aria-label="Your actions">
          {legal.canFold ? (
            <button
              className="btn btn-danger"
              type="button"
              onClick={() =>
                send({
                  type: "action",
                  action: "fold",
                  expectedVersion: view?.sequence,
                  idempotencyKey: crypto.randomUUID(),
                })
              }
            >
              Fold
            </button>
          ) : null}
          {legal.canCheck ? (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() =>
                send({
                  type: "action",
                  action: "check",
                  expectedVersion: view?.sequence,
                  idempotencyKey: crypto.randomUUID(),
                })
              }
            >
              Check
            </button>
          ) : null}
          {legal.canCall ? (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() =>
                send({
                  type: "action",
                  action: "call",
                  expectedVersion: view?.sequence,
                  idempotencyKey: crypto.randomUUID(),
                })
              }
            >
              Call {legal.callAmount}
            </button>
          ) : null}
          {legal.canBet || legal.canRaise ? (
            <>
              <label className="sr-only" htmlFor="raiseTo">
                Raise to
              </label>
              <input
                id="raiseTo"
                type="number"
                min={legal.canBet ? legal.minBet : legal.minRaiseTo}
                max={legal.canBet ? legal.maxBet : legal.maxRaiseTo}
                value={raiseTo}
                onChange={(e) => setRaiseTo(Number(e.target.value))}
                style={{
                  minHeight: 44,
                  borderRadius: 12,
                  border: "1px solid #ffffff22",
                  background: "#06140f",
                  color: "var(--ivory)",
                  padding: "0.5rem 0.75rem",
                  width: 110,
                }}
              />
              <button
                className="btn btn-primary"
                type="button"
                onClick={() =>
                  send({
                    type: "action",
                    action: legal.canBet ? "bet" : "raise",
                    amount: raiseTo,
                    expectedVersion: view?.sequence,
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
              >
                {legal.canBet ? "Bet" : "Raise to"} {raiseTo}
              </button>
            </>
          ) : null}
          {legal.canAllIn ? (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() =>
                send({
                  type: "action",
                  action: "all_in",
                  expectedVersion: view?.sequence,
                  idempotencyKey: crypto.randomUUID(),
                })
              }
            >
              All-in
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "1rem",
          marginTop: "1.25rem",
        }}
      >
        <div className="panel">
          <strong>Table chat</strong>
          <div className="chat" style={{ marginTop: "0.6rem" }}>
            {chat.map((m) => (
              <div key={m.id} className="chat-item">
                <strong>{m.displayName}</strong>: {m.text}
              </div>
            ))}
          </div>
          <form
            style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!chatText.trim()) return;
              send({ type: "chat", text: chatText.trim() });
              setChatText("");
            }}
          >
            <input
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              placeholder="Say something"
              aria-label="Chat message"
              style={{
                flex: 1,
                minHeight: 44,
                borderRadius: 12,
                border: "1px solid #ffffff22",
                background: "#06140f",
                color: "var(--ivory)",
                padding: "0.5rem 0.75rem",
              }}
            />
            <button className="btn btn-secondary" type="submit">
              Send
            </button>
          </form>
        </div>
        <VoicePanel roomId={roomId} />
      </div>
    </section>
  );
}
