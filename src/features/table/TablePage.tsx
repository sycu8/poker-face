import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type LedgerSnapshot, type User } from "../../lib/api";
import { isBotUserId } from "../../lib/bots";
import { SeatMicIndicator } from "../voice/SeatMicIndicator";
import { VoiceSessionProvider } from "../voice/VoiceSession";
import { ActionDock } from "./ActionDock";
import { buildGameAction } from "./gameAction";
import { PlayingCard } from "./PlayingCard";
import { PlayerAvatar } from "./PlayerAvatar";
import {
  seatRingStyle,
  visualSeatIndex,
  seatRingPercents,
  dealOrderSeatIndexes,
} from "./seatLayout";
import { useRoomSocket } from "./useRoomSocket";
import { WinCelebration, winningBestFiveCodes, winningPlayerIds } from "./WinCelebration";

const VoicePanel = lazy(() =>
  import("../voice/VoicePanel").then((m) => ({ default: m.VoicePanel })),
);
const HandHistoryPanel = lazy(() =>
  import("./HandHistoryPanel").then((m) => ({ default: m.HandHistoryPanel })),
);

interface SeatView {
  seatIndex: number;
  playerId: string | null;
  displayName: string | null;
  stack: number;
  status: string;
  betThisStreet: number;
  timeBankMs?: number;
  holeCards: [string, string] | null;
  isViewer: boolean;
}

interface HandResult {
  winners: Array<{
    playerId: string;
    amount: number;
    potIndex: number;
    hand?: {
      category: string;
      label: string;
      bestFive: string[];
      strength: number[];
    };
  }>;
  shownHands?: Array<{ playerId: string; cards: [string, string] }>;
}

interface GameView {
  street: string;
  board: string[];
  pot: number;
  currentBet: number;
  sequence: number;
  handNumber: number;
  dealerSeat?: number;
  actionSeat: number | null;
  turnDeadlineMs: number | null;
  paused?: boolean;
  timeBankActive?: boolean;
  rabbitCards?: string[];
  isSpectator?: boolean;
  seats: SeatView[];
  lastHandResult: HandResult | null;
  pendingConfig: {
    smallBlind?: number;
    startingStack?: number;
    potCapMultiplier?: number;
    timeBankSeconds?: number;
  } | null;
  legalActions: {
    canFold: boolean;
    canCheck: boolean;
    canCall: boolean;
    callAmount: number;
    callIsAllIn?: boolean;
    canBet: boolean;
    canRaise: boolean;
    canShortAllInRaise?: boolean;
    minBet: number;
    maxBet: number;
    minRaiseTo: number;
    maxRaiseTo: number;
    canAllIn: boolean;
    allInAmount?: number;
  } | null;
  config: {
    smallBlind: number;
    bigBlind: number;
    startingStack: number;
    potCapMultiplier: number;
    timeBankSeconds?: number;
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
  const navigate = useNavigate();
  const { roomId = "" } = useParams();
  const [access, setAccess] = useState<"loading" | "member" | "pending" | "rejected">(
    "loading",
  );
  const [view, setView] = useState<GameView | null>(null);
  const [meta, setMeta] = useState<RoomMeta | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [pendingJoins, setPendingJoins] = useState<
    Array<{ requestId: string; userId: string; displayName: string }>
  >([]);
  const [seatPick, setSeatPick] = useState<Record<string, number | "">>({});
  const [openSeats, setOpenSeats] = useState<number[]>([]);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
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
  const [editTimeBank, setEditTimeBank] = useState(60);
  const [ledger, setLedger] = useState<LedgerSnapshot | null>(null);
  const [showLedger, setShowLedger] = useState(false);
  const [spectators, setSpectators] = useState<
    Array<{ userId: string; displayName: string }>
  >([]);
  const [dealBurst, setDealBurst] = useState<{
    handNumber: number;
    dealerSeat: number;
    targets: number[];
  } | null>(null);
  const lastAskAtRef = useRef(0);
  const prevHandRef = useRef(0);
  const dealPrimedRef = useRef(false);
  const disconnectRef = useRef<() => void>(() => {});
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

  const handleSocketMessage = useCallback(
    (data: unknown) => {
      const msg = data as {
        type: string;
        view?: GameView;
        meta?: RoomMeta;
        chat?: ChatMessage[];
        pendingJoins?: Array<{ requestId: string; userId: string; displayName: string }>;
        startRequests?: {
          count: number;
          latestDisplayName: string | null;
          requesters: Array<{ userId: string; displayName: string }>;
        };
        askedToStart?: boolean;
        ledger?: LedgerSnapshot;
        spectators?: Array<{ userId: string; displayName: string }>;
        count?: number;
        latestDisplayName?: string | null;
        requesters?: Array<{ userId: string; displayName: string }>;
        displayName?: string;
        userId?: string;
        message?: ChatMessage | string;
        error?: string;
      };
      if (msg.type === "snapshot" && msg.view) {
        setView(msg.view);
        if (msg.meta) setMeta((m) => ({ ...m, ...msg.meta! }));
        if (msg.chat) setChat(msg.chat);
        if (msg.pendingJoins) setPendingJoins(msg.pendingJoins);
        if (msg.startRequests) setStartRequests(msg.startRequests);
        else if (msg.view.street !== "waiting") {
          setStartRequests({ count: 0, latestDisplayName: null, requesters: [] });
        }
        if (typeof msg.askedToStart === "boolean") setAskedToStart(msg.askedToStart);
        else if (msg.view.street !== "waiting") setAskedToStart(false);
        if (msg.ledger) setLedger(msg.ledger);
        if (msg.spectators) setSpectators(msg.spectators);
        setStatus(msg.view.paused ? "Table paused." : "At the table.");
      }
      if (msg.type === "table_closed") {
        setStatus(typeof msg.message === "string" ? msg.message : "Table closed.");
        setAccess("rejected");
        disconnectRef.current();
        return;
      }
      if (msg.type === "chat" && msg.message) {
        const raw = msg.message;
        const entry: ChatMessage =
          typeof raw === "string"
            ? { id: crypto.randomUUID(), displayName: "Table", text: raw }
            : raw;
        setChat((c) => [...c, entry]);
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
    },
    [user.id],
  );

  const beforeReconnect = useCallback(async () => {
    setStatus("Rejoining your seat…");
    const a = await refreshAccess();
    return a === "member";
  }, [refreshAccess]);

  const { connectionState, actionsEnabled, send, disconnect } = useRoomSocket({
    roomId,
    enabled: access === "member",
    onMessage: handleSocketMessage,
    beforeReconnect,
  });
  disconnectRef.current = disconnect;

  useEffect(() => {
    if (connectionState === "reconnecting") setStatus("Rejoining your seat…");
    else if (connectionState === "offline" && access === "member")
      setStatus("Connecting…");
  }, [connectionState, access]);

  useEffect(() => {
    let cancelled = false;
    let poll: number | undefined;
    void (async () => {
      try {
        const a = await refreshAccess();
        if (cancelled) return;
        if (a === "pending") {
          poll = window.setInterval(() => {
            void refreshAccess().then((next) => {
              if (next === "member" || next === "rejected") {
                if (poll) window.clearInterval(poll);
                poll = undefined;
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
    };
  }, [refreshAccess]);

  const actionsLocked =
    !actionsEnabled || connectionState === "reconnecting" || view?.sequence == null;

  const sendGameAction = useCallback(
    (action: "fold" | "check" | "call" | "bet" | "raise" | "all_in", amount?: number) => {
      const payload = buildGameAction(view?.sequence, action, amount);
      if (payload) send(payload);
    },
    [send, view?.sequence],
  );

  const legal = view?.legalActions;
  useEffect(() => {
    if (legal?.minRaiseTo) setRaiseTo(legal.minRaiseTo);
    else if (legal?.minBet) setRaiseTo(legal.minBet);
  }, [legal?.minRaiseTo, legal?.minBet]);

  const isHost = useMemo(
    () =>
      meta?.hostUserId === user.id ||
      view?.seats.some((s) => s.seatIndex === 0 && s.playerId === user.id),
    [meta, view, user.id],
  );

  const isSeated = useMemo(
    () => Boolean(view?.seats.some((s) => s.playerId === user.id)),
    [view, user.id],
  );

  const mySeat = useMemo(
    () => view?.seats.find((s) => s.playerId === user.id) ?? null,
    [view, user.id],
  );

  const waitingToDeal = view?.street === "waiting";
  const seatedReady = useMemo(
    () =>
      (view?.seats ?? []).filter(
        (s) => s.playerId && s.stack > 0 && s.status !== "sitting_out",
      ).length,
    [view],
  );
  const bustedSelf = Boolean(mySeat && mySeat.stack === 0);

  useEffect(() => {
    if (!isHost || !roomId || pendingJoins.length === 0) return;
    void api
      .openSeats(roomId)
      .then((r) => setOpenSeats(r.openSeats))
      .catch(() => setOpenSeats([]));
  }, [isHost, roomId, pendingJoins.length, view?.sequence]);

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

  async function leaveTable() {
    if (!roomId) return;
    setActionMsg(null);
    try {
      if (isHost) {
        navigate("/");
        return;
      }
      await api.leaveRoom(roomId);
      navigate("/");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Could not leave.");
    }
  }

  async function kickPlayer(targetUserId: string) {
    if (!roomId) return;
    setActionMsg(null);
    try {
      await api.kickPlayer(roomId, targetUserId);
      setActionMsg("Player removed.");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Could not kick.");
    }
  }

  async function addBot(seatIndex?: number) {
    if (!roomId) return;
    setActionMsg(null);
    try {
      const res = await api.addBots(roomId, seatIndex === undefined ? {} : { seatIndex });
      setActionMsg(res.message ?? "Bot seated.");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Could not add bot.");
    }
  }

  async function fillOpenSeatsWithBots() {
    if (!roomId) return;
    setActionMsg(null);
    try {
      const res = await api.addBots(roomId, { fillOpen: true });
      setActionMsg(res.message ?? "Open seats filled with bots.");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Could not add bots.");
    }
  }

  async function doRebuy(targetUserId?: string) {
    if (!roomId) return;
    setActionMsg(null);
    try {
      const res = await api.rebuy(roomId, targetUserId ? { targetUserId } : {});
      setActionMsg(res.message ?? "Stack reset.");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Could not rebuy.");
    }
  }

  async function toggleAway() {
    if (!roomId || !mySeat) return;
    const away = mySeat.status !== "sitting_out";
    setActionMsg(null);
    try {
      const res = await api.setAway(roomId, away);
      setActionMsg(res.message ?? (away ? "Away." : "Back."));
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Could not update presence.");
    }
  }

  const winnerNames = useMemo(() => {
    if (!view?.lastHandResult) return null;
    return view.lastHandResult.winners
      .map((w) => {
        const seat = view.seats.find((s) => s.playerId === w.playerId);
        const rank = w.hand?.label ? ` (${w.hand.label})` : "";
        return `${seat?.displayName ?? "Player"} +${w.amount}${rank}`;
      })
      .join(" · ");
  }, [view]);

  const celebrationWinners = view?.lastHandResult?.winners ?? null;
  const winnerIdSet = useMemo(
    () => (celebrationWinners ? winningPlayerIds(celebrationWinners) : new Set<string>()),
    [celebrationWinners],
  );
  const winningCardCodes = useMemo(
    () =>
      celebrationWinners ? winningBestFiveCodes(celebrationWinners) : new Set<string>(),
    [celebrationWinners],
  );

  const displayNameFor = useCallback(
    (playerId: string) =>
      view?.seats.find((s) => s.playerId === playerId)?.displayName ?? "Player",
    [view],
  );

  const seats = view?.seats ?? [];
  const seatCount = seats.length;
  const anchorSeatIndex = useMemo(() => {
    const viewer = view?.seats.find((s) => s.isViewer);
    if (viewer) return viewer.seatIndex;
    return 0;
  }, [view?.seats]);

  useEffect(() => {
    if (!view) return;
    const hand = view.handNumber;
    if (!dealPrimedRef.current) {
      prevHandRef.current = hand;
      dealPrimedRef.current = true;
      return;
    }
    if (hand > prevHandRef.current && view.street === "preflop") {
      const dealerSeat = view.dealerSeat ?? 0;
      const live = view.seats
        .filter(
          (s) =>
            s.playerId &&
            (s.status === "active" || s.status === "all_in" || s.status === "folded"),
        )
        .map((s) => s.seatIndex);
      const dealt = live.length
        ? live
        : view.seats
            .filter(
              (s) => s.playerId && s.status !== "sitting_out" && s.status !== "empty",
            )
            .map((s) => s.seatIndex);
      const targets = dealOrderSeatIndexes(dealerSeat, dealt, view.seats.length);
      prevHandRef.current = hand;
      if (targets.length > 0) {
        setDealBurst({ handNumber: hand, dealerSeat, targets });
        const ms = 700 + targets.length * 2 * 70;
        const id = window.setTimeout(() => setDealBurst(null), ms);
        return () => window.clearTimeout(id);
      }
      return;
    }
    prevHandRef.current = hand;
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
    return `Join my Poker Faces table “${table}”. Invite code: ${code}. Open ${location.origin} and continue as guest or sign in. Virtual chips only.`;
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
        timeBankSeconds: editTimeBank,
      });
      setConfigMsg(res.message ?? "Updated.");
    } catch (e) {
      setConfigMsg(e instanceof Error ? e.message : "Could not update rules.");
    }
  }

  async function togglePause() {
    if (!roomId || !view) return;
    setActionMsg(null);
    try {
      const next = !view.paused;
      const res = await api.pauseRoom(roomId, next);
      setActionMsg(res.message ?? (next ? "Paused." : "Resumed."));
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Could not pause.");
    }
  }

  async function transferHostTo(targetUserId: string) {
    if (!roomId) return;
    setActionMsg(null);
    try {
      const res = await api.transferHost(roomId, targetUserId);
      setActionMsg(res.message ?? "Host transferred.");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Could not transfer host.");
    }
  }

  async function closeTable() {
    if (!roomId) return;
    if (!window.confirm("Close this table for everyone?")) return;
    setActionMsg(null);
    try {
      await api.closeRoom(roomId);
      navigate("/");
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Could not close table.");
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
      <section className="hero" style={{ justifyItems: "center", textAlign: "center" }}>
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
      <section className="hero" style={{ justifyItems: "center", textAlign: "center" }}>
        <h1>No seat this time</h1>
        <p>{status}</p>
        <div className="cta-row">
          <Link className="btn btn-primary" to="/">
            Back to lobby
          </Link>
        </div>
      </section>
    );
  }

  return (
    <VoiceSessionProvider roomId={roomId!}>
      <section
        className={[
          "table-page",
          legal ? "table-page--dock" : "",
          seatCount >= 7 ? "table-page--dense" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="table-top">
          <div className="table-top-meta">
            <h1>{meta?.roomName ?? "Private table"}</h1>
            <p className="muted">
              {status} · {STREET_LABEL[view?.street ?? "waiting"] ?? view?.street} · Hand{" "}
              {view?.handNumber ?? 0} · Blinds {view?.config.smallBlind ?? "–"}/
              {view?.config.bigBlind ?? "–"}
              {view?.paused ? " · PAUSED" : ""}
              {turnLeft !== null ? ` · ${turnLeft}s` : ""}
              {view?.timeBankActive ? " (time bank)" : ""} ·{" "}
              <span className="badge">Virtual chips only</span>
              {view?.isSpectator ? <span className="badge"> Spectating</span> : null}
            </p>
            {meta?.inviteCode ? (
              <div className="table-invite-row">
                <span>
                  Invite{" "}
                  <strong style={{ letterSpacing: "0.08em" }}>{meta.inviteCode}</strong>
                </span>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void shareInvite()}
                >
                  {shareMsg ?? "Share"}
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void copyInvite()}
                >
                  {copied ? "Copied" : "Copy code"}
                </button>
              </div>
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
          <div className="table-top-actions">
            <div className="cta-row">
              {meta?.inviteCode ? (
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void shareInvite()}
                >
                  {shareMsg ?? "Share table"}
                </button>
              ) : null}
              {isHost && waitingToDeal ? (
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={Boolean(view?.paused)}
                  onClick={() => {
                    setStartRequests({
                      count: 0,
                      latestDisplayName: null,
                      requesters: [],
                    });
                    send({ type: "start_hand" });
                  }}
                >
                  Deal everyone in
                </button>
              ) : null}
              {isHost && seats.some((s) => !s.playerId) ? (
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void fillOpenSeatsWithBots()}
                >
                  Fill open seats with bots
                </button>
              ) : null}
              {isHost ? (
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void togglePause()}
                >
                  {view?.paused ? "Resume" : "Pause"}
                </button>
              ) : null}
              {!isHost && waitingToDeal && isSeated ? (
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={askedToStart || Boolean(view?.paused)}
                  onClick={askHostToStart}
                >
                  {askedToStart ? "Asked host" : "Ask host to start"}
                </button>
              ) : null}
              {waitingToDeal && view?.lastHandResult && (view.board?.length ?? 0) < 5 ? (
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => send({ type: "rabbit" })}
                >
                  Rabbit hunt
                </button>
              ) : null}
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => void leaveTable()}
              >
                {isHost ? "Back to lobby" : "Leave table"}
              </button>
              {isHost ? (
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => void closeTable()}
                >
                  Close table
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {waitingToDeal && access === "member" ? (
          <div
            className="panel between-hand"
            role="status"
            style={{ marginBottom: "1rem", textAlign: "center" }}
          >
            <strong>
              {view?.handNumber ? `Hand #${view.handNumber} complete` : "Waiting to deal"}
            </strong>
            <p className="muted" style={{ margin: "0.35rem 0 0" }}>
              {seatedReady < 2
                ? "Need at least two seated players with chips before the host can deal."
                : isHost
                  ? "Everyone is ready when you are — deal the next hand."
                  : askedToStart
                    ? "Host has been asked to deal. Hang tight."
                    : "Waiting for the host to deal the next hand."}
            </p>
            {bustedSelf ? (
              <div
                className="cta-row"
                style={{ marginTop: "0.75rem", justifyContent: "center" }}
              >
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void doRebuy()}
                >
                  Rebuy play-money stack
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {actionMsg ? (
          <p className="badge" role="status" style={{ marginBottom: "0.75rem" }}>
            {actionMsg}
          </p>
        ) : null}

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
          <div className="panel" style={{ marginBottom: "1rem", textAlign: "center" }}>
            <strong>Join requests</strong>
            {pendingJoins.map((j) => (
              <div key={j.requestId} className="join-request-row">
                <span>{j.displayName} asks to join</span>
                <label
                  className="muted"
                  style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
                >
                  Seat
                  <select
                    value={seatPick[j.requestId] ?? ""}
                    onChange={(e) =>
                      setSeatPick((m) => ({
                        ...m,
                        [j.requestId]:
                          e.target.value === "" ? "" : Number(e.target.value),
                      }))
                    }
                  >
                    <option value="">Auto</option>
                    {openSeats.map((s) => (
                      <option key={s} value={s}>
                        #{s + 1}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="cta-row">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() =>
                      void api
                        .decideJoin({
                          requestId: j.requestId,
                          approve: true,
                          seatIndex:
                            seatPick[j.requestId] === "" ||
                            seatPick[j.requestId] === undefined
                              ? undefined
                              : Number(seatPick[j.requestId]),
                          idempotencyKey: crypto.randomUUID(),
                        })
                        .then(() =>
                          setPendingJoins((list) =>
                            list.filter((x) => x.requestId !== j.requestId),
                          ),
                        )
                        .catch((e) =>
                          setActionMsg(
                            e instanceof Error ? e.message : "Could not approve.",
                          ),
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
                          approve: true,
                          asSpectator: true,
                          seatIndex: null,
                          idempotencyKey: crypto.randomUUID(),
                        })
                        .then(() =>
                          setPendingJoins((list) =>
                            list.filter((x) => x.requestId !== j.requestId),
                          ),
                        )
                        .catch((e) =>
                          setActionMsg(
                            e instanceof Error ? e.message : "Could not approve.",
                          ),
                        )
                    }
                  >
                    Spectate
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
                          setPendingJoins((list) =>
                            list.filter((x) => x.requestId !== j.requestId),
                          ),
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

        <div className="table-stage">
          <div className="table-felt" aria-label="Poker table">
            {celebrationWinners && celebrationWinners.length > 0 ? (
              <WinCelebration
                winners={celebrationWinners}
                displayNameFor={displayNameFor}
                handNumber={view?.handNumber ?? 0}
              />
            ) : null}
            <div className="table-center">
              <div className="board">
                {(view?.board?.length ? view.board : ["?", "?", "?", "?", "?"]).map(
                  (c, i) => (
                    <PlayingCard
                      key={`${c}-${i}`}
                      code={c}
                      size="board"
                      className={winningCardCodes.has(c) ? "playing-card--winning" : ""}
                    />
                  ),
                )}
              </div>
              {view?.rabbitCards && view.rabbitCards.length > 0 ? (
                <div
                  className="board"
                  aria-label="Rabbit hunt cards"
                  style={{ marginTop: "0.35rem" }}
                >
                  {view.rabbitCards.map((c, i) => (
                    <PlayingCard key={`rabbit-${c}-${i}`} code={c} size="sm" />
                  ))}
                  <span className="muted" style={{ alignSelf: "center" }}>
                    Rabbit
                  </span>
                </div>
              ) : null}
              <div className="pot">
                Pot {view?.pot ?? 0}
                {view?.street ? ` · ${STREET_LABEL[view.street] ?? view.street}` : ""}
                {view?.paused ? " · paused" : ""}
              </div>
            </div>
            {dealBurst ? (
              <div className="deal-layer" aria-hidden="true">
                {dealBurst.targets.flatMap((seatIndex, order) => {
                  const visual = visualSeatIndex(seatIndex, seatCount, anchorSeatIndex);
                  const to = seatRingPercents(visual, seatCount);
                  const fromVisual = visualSeatIndex(
                    dealBurst.dealerSeat,
                    seatCount,
                    anchorSeatIndex,
                  );
                  const from = seatRingPercents(fromVisual, seatCount);
                  return [0, 1].map((cardIdx) => {
                    const step = order * 2 + cardIdx;
                    return (
                      <div
                        key={`deal-${dealBurst.handNumber}-${seatIndex}-${cardIdx}`}
                        className="deal-flyer"
                        style={
                          {
                            "--deal-from-x": `${from.left}%`,
                            "--deal-from-y": `${from.top}%`,
                            "--deal-to-x": `${to.left}%`,
                            "--deal-to-y": `${to.top}%`,
                            animationDelay: `${step * 70}ms`,
                          } as CSSProperties
                        }
                      >
                        <PlayingCard code="?" size="sm" />
                      </div>
                    );
                  });
                })}
              </div>
            ) : null}
            <div
              className={["seats", seatCount >= 7 ? "seats--dense" : ""]
                .filter(Boolean)
                .join(" ")}
              role="list"
            >
              {seats.map((seat) => {
                const visual = visualSeatIndex(
                  seat.seatIndex,
                  seatCount,
                  anchorSeatIndex,
                );
                const isHero = seat.isViewer;
                const isDealer =
                  view?.dealerSeat === seat.seatIndex && Boolean(seat.playerId);
                const dealingHere = Boolean(dealBurst?.targets.includes(seat.seatIndex));
                const holeCodes: [string, string] | null =
                  seat.holeCards ??
                  (dealingHere && !isHero ? (["?", "?"] as [string, string]) : null);
                const dealOrder = dealBurst
                  ? dealBurst.targets.indexOf(seat.seatIndex)
                  : -1;
                return (
                  <div
                    key={seat.seatIndex}
                    role="listitem"
                    className={[
                      "seat",
                      isHero ? "seat--hero" : "seat--rail",
                      !seat.playerId ? "seat--open" : "",
                      view?.actionSeat === seat.seatIndex ? "active-turn" : "",
                      seat.playerId && winnerIdSet.has(seat.playerId)
                        ? "seat--winner"
                        : "",
                      seat.status === "sitting_out" ? "seat--away" : "",
                      isDealer ? "seat--dealer" : "",
                      dealingHere ? "seat--dealing" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={seatRingStyle(visual, seatCount)}
                  >
                    {isDealer ? (
                      <span
                        className="seat-dealer-chip"
                        title="Dealer"
                        aria-label="Dealer"
                      >
                        D
                      </span>
                    ) : null}
                    <div className="seat-info">
                      <div className="name">
                        {seat.displayName ? (
                          <PlayerAvatar name={seat.displayName} size={isHero ? 32 : 22} />
                        ) : null}
                        <span className="seat-name-text">
                          {seat.displayName ?? "Open"}
                          {isHero ? " (you)" : ""}
                          {seat.playerId && isBotUserId(seat.playerId) ? " · bot" : ""}
                        </span>
                        {seat.playerId ? (
                          <SeatMicIndicator playerId={seat.playerId} />
                        ) : null}
                      </div>
                      <div className="seat-status muted">
                        {seat.playerId ? seat.status.replaceAll("_", " ") : "Open seat"}
                      </div>
                      {seat.playerId ? (
                        <div className="stack">
                          {seat.stack}
                          {seat.betThisStreet > 0 ? ` · ${seat.betThisStreet}` : ""}
                          {typeof seat.timeBankMs === "number" && seat.timeBankMs > 0
                            ? ` · bank ${Math.ceil(seat.timeBankMs / 1000)}s`
                            : ""}
                        </div>
                      ) : null}
                      {!seat.playerId && isHost ? (
                        <div className="seat-host-actions">
                          <button
                            className="btn btn-secondary"
                            type="button"
                            onClick={() => void addBot(seat.seatIndex)}
                          >
                            Add bot
                          </button>
                        </div>
                      ) : null}
                      {seat.playerId && isHost && seat.playerId !== user.id ? (
                        <div className="seat-host-actions">
                          <button
                            className="btn btn-secondary"
                            type="button"
                            onClick={() => void kickPlayer(seat.playerId!)}
                          >
                            Kick
                          </button>
                          {!isBotUserId(seat.playerId) ? (
                            <button
                              className="btn btn-secondary"
                              type="button"
                              onClick={() => void transferHostTo(seat.playerId!)}
                            >
                              Make host
                            </button>
                          ) : null}
                          {seat.stack === 0 ? (
                            <button
                              className="btn btn-secondary"
                              type="button"
                              onClick={() => void doRebuy(seat.playerId!)}
                            >
                              Rebuy
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    {holeCodes ? (
                      <div
                        className={`seat-holes${isHero ? " seat-holes--hero" : ""}${
                          dealingHere ? " seat-holes--deal-in" : ""
                        }`}
                        style={
                          dealingHere && dealOrder >= 0
                            ? ({
                                "--deal-reveal-delay": `${dealOrder * 2 * 70 + 320}ms`,
                              } as CSSProperties)
                            : undefined
                        }
                      >
                        {holeCodes.map((c, i) => (
                          <PlayingCard
                            key={`${c}-${i}-${view?.handNumber ?? 0}`}
                            code={c}
                            size={isHero ? "hero" : "sm"}
                            className={[
                              winningCardCodes.has(c) ? "playing-card--winning" : "",
                              dealingHere ? "playing-card--dealt" : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            style={
                              dealingHere
                                ? ({ animationDelay: `${i * 70}ms` } as CSSProperties)
                                : undefined
                            }
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {legal ? (
            <>
              <div
                className="actions actions--hero actions--desktop"
                aria-label="Your actions"
              >
                {legal.canFold ? (
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={actionsLocked}
                    onClick={() => sendGameAction("fold")}
                  >
                    Fold
                  </button>
                ) : null}
                {legal.canCheck ? (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    disabled={actionsLocked}
                    onClick={() => sendGameAction("check")}
                  >
                    Check
                  </button>
                ) : null}
                {legal.canCall ? (
                  <button
                    className="btn btn-secondary"
                    type="button"
                    disabled={actionsLocked}
                    onClick={() => sendGameAction("call")}
                  >
                    {legal.callIsAllIn
                      ? `All-in ${legal.callAmount}`
                      : `Call ${legal.callAmount}`}
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
                      disabled={actionsLocked}
                      onChange={(e) => setRaiseTo(Number(e.target.value))}
                    />
                    <button
                      className="btn btn-primary"
                      type="button"
                      disabled={actionsLocked}
                      onClick={() =>
                        sendGameAction(legal.canBet ? "bet" : "raise", raiseTo)
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
                    disabled={actionsLocked}
                    onClick={() => sendGameAction("all_in")}
                  >
                    All-in
                  </button>
                ) : null}
              </div>
              <ActionDock
                className="action-dock--mobile"
                legal={legal}
                pot={view?.pot ?? 0}
                currentBet={view?.currentBet ?? 0}
                sequence={view?.sequence}
                disabled={actionsLocked}
                onSend={send}
                raiseTo={raiseTo}
                onRaiseToChange={setRaiseTo}
              />
            </>
          ) : null}
        </div>

        <div className="table-side-grid">
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
              className="chat-form"
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
              />
              <button className="btn btn-secondary" type="submit">
                Send
              </button>
            </form>
          </div>
          <div className="panel">
            <div
              className="cta-row"
              style={{ justifyContent: "center", marginBottom: "0.5rem" }}
            >
              {isSeated && waitingToDeal ? (
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void toggleAway()}
                >
                  {mySeat?.status === "sitting_out" ? "I am back" : "Sit out / away"}
                </button>
              ) : null}
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setShowHistory((v) => !v)}
              >
                {showHistory ? "Hide hand history" : "Hand history"}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setShowLedger((v) => !v)}
              >
                {showLedger ? "Hide ledger" : "Session ledger"}
              </button>
            </div>
            {showLedger && ledger ? (
              <div style={{ marginBottom: "0.75rem" }}>
                <strong>Session ledger</strong>
                <table
                  style={{ width: "100%", fontSize: "0.85rem", marginTop: "0.5rem" }}
                >
                  <thead>
                    <tr>
                      <th align="left">Player</th>
                      <th align="right">In</th>
                      <th align="right">Out</th>
                      <th align="right">Stack</th>
                      <th align="right">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.players.map((p) => (
                      <tr key={p.userId}>
                        <td>
                          {p.displayName}
                          {!p.active ? " (left)" : ""}
                        </td>
                        <td align="right">{p.buyIn}</td>
                        <td align="right">{p.buyOut}</td>
                        <td align="right">{p.currentStack}</td>
                        <td align="right">{p.net}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <strong>Totals</strong>
                      </td>
                      <td align="right">{ledger.totals.buyIn}</td>
                      <td align="right">{ledger.totals.buyOut}</td>
                      <td align="right">{ledger.totals.currentStack}</td>
                      <td align="right">{ledger.totals.net}</td>
                    </tr>
                  </tbody>
                </table>
                <button
                  className="btn btn-secondary"
                  type="button"
                  style={{ marginTop: "0.5rem" }}
                  onClick={() =>
                    void api
                      .downloadLedgerCsv(roomId)
                      .catch((e) =>
                        setActionMsg(
                          e instanceof Error ? e.message : "Could not download CSV.",
                        ),
                      )
                  }
                >
                  Download CSV
                </button>
              </div>
            ) : null}
            {spectators.length > 0 ? (
              <p className="muted" style={{ marginBottom: "0.5rem" }}>
                Watching: {spectators.map((s) => s.displayName).join(", ")}
              </p>
            ) : null}
            {showHistory && roomId ? (
              <Suspense fallback={<p className="muted">Loading history…</p>}>
                <HandHistoryPanel roomId={roomId} />
              </Suspense>
            ) : null}
            <Suspense fallback={null}>
              <VoicePanel />
            </Suspense>
          </div>
          {isHost ? (
            <div className="panel">
              <strong>Table rules</strong>
              <p className="muted">
                Mid-hand changes apply on the next deal. Max 10 seats · Hold&apos;em only.
              </p>
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
              <div className="field">
                <label htmlFor="editTimeBank">Time bank (seconds)</label>
                <input
                  id="editTimeBank"
                  type="number"
                  min={0}
                  max={600}
                  value={editTimeBank}
                  onChange={(e) => setEditTimeBank(Number(e.target.value))}
                />
              </div>
              <div className="panel-actions">
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void saveRules()}
                >
                  Save rules
                </button>
              </div>
              {configMsg ? (
                <p className="muted" style={{ textAlign: "center" }}>
                  {configMsg}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </VoiceSessionProvider>
  );
}
