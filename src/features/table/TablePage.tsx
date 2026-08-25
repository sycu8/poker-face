import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
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

interface HandResult {
  winners: Array<{ playerId: string; amount: number; potIndex: number }>;
  shownHands?: Array<{ playerId: string; cards: [string, string] }>;
}

interface GameView {
  street: string;
  board: string[];
  pot: number;
  sequence: number;
  handNumber: number;
  actionSeat: number | null;
  turnDeadlineMs: number | null;
  seats: SeatView[];
  lastHandResult: HandResult | null;
  pendingConfig: {
    smallBlind?: number;
    startingStack?: number;
    potCapMultiplier?: number;
  } | null;
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
  config: {
    smallBlind: number;
    bigBlind: number;
    startingStack: number;
    potCapMultiplier: number;
  };
}

interface RoomMeta {
  roomId: string | null;
  roomName: string | null;
  inviteCode: string | null;
  hostUserId: string | null;
}

interface ChatMessage {
  id: string;
  displayName: string;
  text: string;
}

const STREET_LABEL: Record<string, string> = {
  waiting: "Waiting to deal",
  preflop: "Preflop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};

function useTurnSeconds(deadlineMs: number | null): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!deadlineMs) {
      setLeft(null);
      return;
    }
    const tick = () => setLeft(Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [deadlineMs]);
  return left;
}

export function TablePage({ user }: { user: User }) {
  const { roomId = "" } = useParams();
  const [access, setAccess] = useState<"loading" | "member" | "pending" | "rejected">("loading");
  const [view, setView] = useState<GameView | null>(null);
  const [meta, setMeta] = useState<RoomMeta | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [pendingJoins, setPendingJoins] = useState<
    Array<{ requestId: string; userId: string; displayName: string }>
  >([]);
  const [startRequests, setStartRequests] = useState<{
    count: number;
    latestDisplayName: string | null;
    requesters: Array<{ userId: string; displayName: string }>;
  }>({ count: 0, latestDisplayName: null, requesters: [] });
  const [askedToStart, setAskedToStart] = useState(false);
  const [status, setStatus] = useState("Connecting…");
  const [chatText, setChatText] = useState("");
  const [raiseTo, setRaiseTo] = useState(0);
  const [copied, setCopied] = useState(false);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const [configMsg, setConfigMsg] = useState<string | null>(null);
  const [editSb, setEditSb] = useState(1);
  const [editStack, setEditStack] = useState(100);
  const [editCap, setEditCap] = useState(2);
  const wsRef = useRef<WebSocket | null>(null);
  const lastAskAtRef = useRef(0);
  const turnLeft = useTurnSeconds(view?.turnDeadlineMs ?? null);

  const refreshAccess = useCallback(async () => {
    const res = await api.getRoom(roomId);
    if (res.access === "member") {
      setAccess("member");
      setMeta({
        roomId: res.room.id,
        roomName: res.room.name,
        inviteCode: res.room.inviteCode,
        hostUserId: res.room.hostUserId,
      });
      setEditSb(res.room.smallBlind);
      setEditStack(res.room.startingStack);
      setEditCap(res.room.potCapMultiplier);
      return "member" as const;
    }
    if (res.access === "pending") {
      setAccess("pending");
      setMeta({
        roomId: res.room.id,
        roomName: res.room.name,
        inviteCode: res.room.inviteCode,
        hostUserId: res.room.hostUserId,
      });
      setStatus(res.message);
      return "pending" as const;
    }
    setAccess("rejected");
    setStatus(res.message);
    return "rejected" as const;
  }, [roomId]);

  const connect = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/rooms/${roomId}`);
    wsRef.current = ws;
    ws.onopen = () => setStatus("Connected");
    ws.onclose = () => {
      setStatus("Rejoining your seat…");
      setTimeout(() => {
        void refreshAccess().then((a) => {
          if (a === "member") connect();
        });
      }, 1200);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as {
        type: string;
        view?: GameView;
        meta?: RoomMeta;
        chat?: ChatMessage[];
        pendingJoins?: typeof pendingJoins;
        startRequests?: {
          count: number;
          latestDisplayName: string | null;
          requesters: Array<{ userId: string; displayName: string }>;
        };
        askedToStart?: boolean;
        count?: number;
        latestDisplayName?: string | null;
        requesters?: Array<{ userId: string; displayName: string }>;
        displayName?: string;
        userId?: string;
        message?: ChatMessage;
        error?: string;
      };
      if (msg.type === "snapshot" && msg.view) {
        setView(msg.view);
        if (msg.meta) setMeta((m) => ({ ...m, ...msg.meta! }));
        if (msg.chat) setChat(msg.chat);
        if (msg.pendingJoins) setPendingJoins(msg.pendingJoins);
        else if (msg.pendingJoins === undefined && msg.meta?.hostUserId !== user.id) {
          /* keep */
        }
        if (msg.startRequests) setStartRequests(msg.startRequests);
        else if (msg.view.street !== "waiting") {
          setStartRequests({ count: 0, latestDisplayName: null, requesters: [] });
        }
        if (typeof msg.askedToStart === "boolean") setAskedToStart(msg.askedToStart);
        else if (msg.view.street !== "waiting") setAskedToStart(false);
        setStatus("At the table.");
      }
      if (msg.type === "chat" && msg.message) {
        setChat((c) => [...c, msg.message!]);
      }
      if (msg.type === "join_request" && msg) {
        const jr = msg as unknown as {
          requestId: string;
          userId: string;
          displayName: string;
        };
        if (jr.requestId) {
          setPendingJoins((list) =>
            list.some((x) => x.requestId === jr.requestId) ? list : [...list, jr],
          );
        }
      }
      if (msg.type === "start_request") {
        setStartRequests({
          count: msg.count ?? 0,
          latestDisplayName: msg.latestDisplayName ?? msg.displayName ?? null,
          requesters: msg.requesters ?? [],
        });
        if (msg.userId === user.id) setAskedToStart(true);
      }
      if (msg.type === "start_request_ack") {
        setAskedToStart(true);
        if (typeof msg.count === "number") {
          setStartRequests({
            count: msg.count,
            latestDisplayName: msg.latestDisplayName ?? null,
            requesters: msg.requesters ?? [],
          });
        }
      }
      if (msg.type === "error" && msg.error) setStatus(msg.error);
    };
  }, [roomId, refreshAccess, user.id]);

  useEffect(() => {
    let cancelled = false;
    let poll: number | undefined;
    void (async () => {
      try {
        const a = await refreshAccess();
        if (cancelled) return;
        if (a === "member") connect();
        if (a === "pending") {
          poll = window.setInterval(() => {
            void refreshAccess().then((next) => {
              if (next === "member") {
                if (poll) window.clearInterval(poll);
                connect();
              }
            });
          }, 2000);
        }
      } catch (e) {
        if (!cancelled) {
          setAccess("rejected");
          setStatus(e instanceof Error ? e.message : "Could not open this table.");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (poll) window.clearInterval(poll);
      wsRef.current?.close();
    };
  }, [connect, refreshAccess]);

  const send = (payload: unknown) => {
    wsRef.current?.send(JSON.stringify(payload));
  };

  const legal = view?.legalActions;
  useEffect(() => {
    if (legal?.minRaiseTo) setRaiseTo(legal.minRaiseTo);
    else if (legal?.minBet) setRaiseTo(legal.minBet);
  }, [legal?.minRaiseTo, legal?.minBet]);

  const isHost = useMemo(
    () => meta?.hostUserId === user.id || view?.seats.some((s) => s.seatIndex === 0 && s.playerId === user.id),
    [meta, view, user.id],
  );

  const isSeated = useMemo(
    () => Boolean(view?.seats.some((s) => s.playerId === user.id)),
    [view, user.id],
  );

  const waitingToDeal = view?.street === "waiting";

  const startRequestLabel = useMemo(() => {
    if (startRequests.count <= 0) return null;
    if (startRequests.count === 1) {
      return `${startRequests.latestDisplayName ?? "A player"} asks to start`;
    }
    const latest = startRequests.latestDisplayName ?? "a player";
    return `${startRequests.count} players want to start · latest: ${latest}`;
  }, [startRequests]);

  function askHostToStart() {
    const now = Date.now();
    if (now - lastAskAtRef.current < 2_000) return;
    lastAskAtRef.current = now;
    setAskedToStart(true);
    send({ type: "request_start" });
  }

  const winnerNames = useMemo(() => {
    if (!view?.lastHandResult) return null;
    return view.lastHandResult.winners
      .map((w) => {
        const seat = view.seats.find((s) => s.playerId === w.playerId);
        return `${seat?.displayName ?? "Player"} +${w.amount}`;
      })
      .join(" · ");
  }, [view]);

  async function copyInvite() {
    if (!meta?.inviteCode) return;
    await navigator.clipboard.writeText(meta.inviteCode);
    setCopied(true);
    setShareMsg(null);
    setTimeout(() => setCopied(false), 1500);
  }

  function shareText() {
    const code = meta?.inviteCode ?? "";
    const table = meta?.roomName ?? "Poker Faces table";
    return `Join my Poker Faces table “${table}”. Invite code: ${code}. Open ${location.origin}, sign in, and ask to join. Virtual chips only.`;
  }

  async function shareInvite() {
    if (!meta?.inviteCode) return;
    const title = meta.roomName ? `Join ${meta.roomName}` : "Join my Poker Faces table";
    const text = shareText();
    const url = location.origin;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, text, url });
        setShareMsg("Shared");
        setTimeout(() => setShareMsg(null), 1500);
        return;
      }
      await navigator.clipboard.writeText(text);
      setShareMsg("Invite copied");
      setTimeout(() => setShareMsg(null), 1500);
    } catch (err) {
      // User canceled the share sheet — ignore AbortError.
      if (err instanceof DOMException && err.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(text);
        setShareMsg("Invite copied");
        setTimeout(() => setShareMsg(null), 1500);
      } catch {
        setShareMsg("Could not share");
      }
    }
  }

  async function saveRules() {
    setConfigMsg(null);
    try {
      const res = await api.updateRoomConfig(roomId, {
        smallBlind: editSb,
        startingStack: editStack,
        potCapMultiplier: editCap,
      });
      setConfigMsg(res.message ?? "Updated.");
    } catch (e) {
      setConfigMsg(e instanceof Error ? e.message : "Could not update rules.");
    }
  }

  if (access === "loading") {
    return (
      <section className="hero">
        <h1>Opening the table…</h1>
        <p className="muted">{status}</p>
      </section>
    );
  }

  if (access === "pending") {
    return (
      <section className="hero">
        <h1>{meta?.roomName ?? "Private table"}</h1>
        <p>Waiting for the host to approve your seat. Virtual chips only.</p>
        <p className="badge">{status}</p>
        {meta?.inviteCode ? <p className="muted">Invite code {meta.inviteCode}</p> : null}
        <div className="cta-row">
          <Link className="btn btn-secondary" to="/">
            Back to lobby
          </Link>
        </div>
      </section>
    );
  }

  if (access === "rejected") {
    return (
      <section className="hero">
        <h1>No seat this time</h1>
        <p>{status}</p>
        <Link className="btn btn-primary" to="/">
          Back to lobby
        </Link>
      </section>
    );
  }

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontFamily: "var(--font-display)", marginBottom: 0 }}>
            {meta?.roomName ?? "Private table"}
          </h1>
          <p className="muted" style={{ marginTop: 0 }}>
            {status} · {STREET_LABEL[view?.street ?? "waiting"] ?? view?.street} · Hand{" "}
            {view?.handNumber ?? 0} · Blinds {view?.config.smallBlind ?? "–"}/
            {view?.config.bigBlind ?? "–"}
            {turnLeft !== null ? ` · ${turnLeft}s` : ""} ·{" "}
            <span className="badge">Virtual chips only</span>
          </p>
          {meta?.inviteCode ? (
            <p style={{ marginTop: "0.35rem", display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
              Invite{" "}
              <strong style={{ letterSpacing: "0.08em" }}>{meta.inviteCode}</strong>
              <button className="btn btn-primary" type="button" onClick={() => void shareInvite()}>
                {shareMsg ?? "Share"}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => void copyInvite()}>
                {copied ? "Copied" : "Copy code"}
              </button>
            </p>
          ) : null}
          {winnerNames ? (
            <p className="badge" style={{ marginTop: "0.5rem" }}>
              Last hand: {winnerNames}
            </p>
          ) : null}
          {view?.pendingConfig ? (
            <p className="muted">Rule changes pending for the next hand.</p>
          ) : null}
        </div>
        <div className="cta-row" style={{ justifyContent: "center" }}>
          {meta?.inviteCode ? (
            <button className="btn btn-secondary" type="button" onClick={() => void shareInvite()}>
              {shareMsg ?? "Share table"}
            </button>
          ) : null}
          {isHost ? (
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => {
                setStartRequests({ count: 0, latestDisplayName: null, requesters: [] });
                send({ type: "start_hand" });
              }}
            >
              Deal everyone in
            </button>
          ) : null}
          {!isHost && waitingToDeal && isSeated ? (
            <button
              className="btn btn-primary"
              type="button"
              disabled={askedToStart}
              onClick={askHostToStart}
            >
              {askedToStart ? "Asked host" : "Ask host to start"}
            </button>
          ) : null}
          <Link className="btn btn-secondary" to="/">
            Leave table
          </Link>
        </div>
      </div>

      {isHost && waitingToDeal && startRequestLabel ? (
        <div
          className="panel"
          style={{
            marginBottom: "1rem",
            borderColor: "#f4bc5666",
            display: "grid",
            gap: "0.75rem",
            justifyItems: "center",
            textAlign: "center",
          }}
          role="status"
        >
          <strong>{startRequestLabel}</strong>
          <p className="muted" style={{ margin: 0 }}>
            Ready when you are — deal is still yours to start.
          </p>
          <div className="cta-row" style={{ justifyContent: "center" }}>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => {
                setStartRequests({ count: 0, latestDisplayName: null, requesters: [] });
                send({ type: "start_hand" });
              }}
            >
              Deal everyone in
            </button>
          </div>
        </div>
      ) : null}

      {pendingJoins.length > 0 && isHost ? (
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
                flexWrap: "wrap",
              }}
            >
              <span>{j.displayName} asks to join</span>
              <div className="cta-row">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() =>
                    void api
                      .decideJoin({
                        requestId: j.requestId,
                        approve: true,
                        idempotencyKey: crypto.randomUUID(),
                      })
                      .then(() =>
                        setPendingJoins((list) => list.filter((x) => x.requestId !== j.requestId)),
                      )
                  }
                >
                  Take a seat
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() =>
                    void api
                      .decideJoin({
                        requestId: j.requestId,
                        approve: false,
                        idempotencyKey: crypto.randomUUID(),
                      })
                      .then(() =>
                        setPendingJoins((list) => list.filter((x) => x.requestId !== j.requestId)),
                      )
                  }
                >
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="table-felt" aria-label="Poker table">
        <div className="board">
          {(view?.board?.length ? view.board : ["?", "?", "?", "?", "?"]).map((c, i) => (
            <div
              key={`${c}-${i}`}
              className={c === "?" ? "card back" : "card"}
              aria-label={c === "?" ? "Hidden card" : c}
            >
              {c === "?" ? "" : c}
            </div>
          ))}
        </div>
        <div className="pot">
          Pot {view?.pot ?? 0}
          {view?.street ? ` · ${STREET_LABEL[view.street] ?? view.street}` : ""}
        </div>
      </div>

      <div className="seats">
        {(view?.seats ?? []).map((seat) => (
          <div
            key={seat.seatIndex}
            className={`seat${view?.actionSeat === seat.seatIndex ? " active-turn" : ""}`}
          >
            <div className="name">
              {seat.displayName ?? "Open seat"}
              {seat.isViewer ? " (you)" : ""}
            </div>
            <div className="muted">{seat.status.replaceAll("_", " ")}</div>
            {seat.playerId ? (
              <div className="stack">
                {seat.stack} chips
                {seat.betThisStreet > 0 ? ` · bet ${seat.betThisStreet}` : ""}
              </div>
            ) : null}
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
        {isHost ? (
          <div className="panel">
            <strong>Table rules</strong>
            <p className="muted">Mid-hand changes apply on the next deal.</p>
            <div className="field">
              <label htmlFor="editSb">Small blind</label>
              <input
                id="editSb"
                type="number"
                min={1}
                value={editSb}
                onChange={(e) => setEditSb(Number(e.target.value))}
              />
              <span className="muted">Big blind {editSb * 2}</span>
            </div>
            <div className="field">
              <label htmlFor="editStack">Starting stack</label>
              <input
                id="editStack"
                type="number"
                min={10}
                max={1000}
                value={editStack}
                onChange={(e) => setEditStack(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="editCap">Pot-cap multiplier</label>
              <input
                id="editCap"
                type="number"
                min={1}
                max={10}
                step={0.5}
                value={editCap}
                onChange={(e) => setEditCap(Number(e.target.value))}
              />
            </div>
            <button className="btn btn-secondary" type="button" onClick={() => void saveRules()}>
              Save rules
            </button>
            {configMsg ? <p className="muted">{configMsg}</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
