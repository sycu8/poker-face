import type { Card } from "./cards";
import { buildDeck, shuffleDeck } from "./cards";
import {
  maxTargetWager,
  MIN_SEATS_TO_DEAL,
  promoteConfig,
  type PendingConfig,
  type PlayerStatus,
  type Street,
  type TableConfig,
} from "./config";
import {
  categoryDisplayLabel,
  compareHands,
  evaluateBestHand,
  type HandCategory,
} from "./handRank";
import { computeSidePots, type SidePot } from "./pots";

export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "all_in";

export interface SeatState {
  seatIndex: number;
  playerId: string | null;
  displayName: string | null;
  stack: number;
  status: PlayerStatus;
  holeCards: [Card, Card] | null;
  betThisStreet: number;
  committedThisHand: number;
  hasActedThisStreet: boolean;
  /** Remaining time-bank pool in ms for this seat. */
  timeBankMs: number;
}

/** Per-winner showdown details; omitted when the pot was won uncontested (fold). */
export interface WinningHandInfo {
  /** Engine category (`straight_flush` for royal flush). */
  category: HandCategory;
  /** User-facing label, e.g. "Royal flush", "Full house". */
  label: string;
  /** Best five cards that made the hand. */
  bestFive: Card[];
  /** Tie-break strength ranks from evaluateBestHand. */
  strength: number[];
}

export interface HandResult {
  winners: Array<{
    playerId: string;
    amount: number;
    potIndex: number;
    /** Present when the pot was decided at showdown (2+ eligible). */
    hand?: WinningHandInfo;
  }>;
  pots: SidePot[];
  shownHands: Array<{ playerId: string; cards: [Card, Card] }>;
}

export interface GameState {
  config: TableConfig;
  pendingConfig: PendingConfig | null;
  seats: SeatState[];
  street: Street;
  board: Card[];
  deck: Card[];
  pot: number;
  currentBet: number;
  minRaise: number;
  dealerSeat: number;
  actionSeat: number | null;
  handNumber: number;
  sequence: number;
  lastHandResult: HandResult | null;
  turnDeadlineMs: number | null;
  /** Host paused the table (no deal / frozen timers). */
  paused: boolean;
  /** When pause froze a mid-hand timer, remaining ms until deadline. */
  pausedTurnRemainingMs: number | null;
  /**
   * When the primary turn timer expired and time bank started burning.
   * Null when not in time-bank phase.
   */
  timeBankStartedMs: number | null;
  /** Milliseconds of time bank allocated when the bank phase began. */
  timeBankExtensionMs: number | null;
  /** Rabbit-hunt cards revealed after a hand (undealt board only). */
  rabbitCards: Card[];
}

export type EngineEvent =
  | { type: "hand_started"; handNumber: number; dealerSeat: number }
  | { type: "blinds_posted"; sb: number; bb: number; pot: number }
  | { type: "dealt_hole" }
  | { type: "board"; street: Street; cards: Card[] }
  | {
      type: "action";
      playerId: string;
      action: ActionType;
      amount: number;
      pot: number;
    }
  | { type: "hand_complete"; result: HandResult }
  | { type: "config_promoted"; config: TableConfig }
  | { type: "turn"; seatIndex: number; deadlineMs: number }
  | { type: "paused"; paused: boolean }
  | { type: "rabbit"; cards: Card[] }
  | { type: "time_bank"; seatIndex: number; remainingMs: number; deadlineMs: number };

export function createEmptySeats(maxSeats: number): SeatState[] {
  return Array.from({ length: maxSeats }, (_, seatIndex) => ({
    seatIndex,
    playerId: null,
    displayName: null,
    stack: 0,
    status: "empty" as const,
    holeCards: null,
    betThisStreet: 0,
    committedThisHand: 0,
    hasActedThisStreet: false,
    timeBankMs: 0,
  }));
}

export function createInitialGameState(config: TableConfig): GameState {
  const normalized = normalizeConfig(config);
  return {
    config: normalized,
    pendingConfig: null,
    seats: createEmptySeats(normalized.maxSeats),
    street: "waiting",
    board: [],
    deck: [],
    pot: 0,
    currentBet: 0,
    minRaise: normalized.bigBlind,
    dealerSeat: 0,
    actionSeat: null,
    handNumber: 0,
    sequence: 0,
    lastHandResult: null,
    turnDeadlineMs: null,
    paused: false,
    pausedTurnRemainingMs: null,
    timeBankStartedMs: null,
    timeBankExtensionMs: null,
    rabbitCards: [],
  };
}

/** Backfill older persisted configs / seats after schema additions. */
export function normalizeConfig(config: TableConfig): TableConfig {
  return {
    ...config,
    timeBankSeconds:
      typeof config.timeBankSeconds === "number" ? config.timeBankSeconds : 60,
    maxSeats: config.maxSeats >= 2 ? config.maxSeats : 10,
  };
}

export function normalizeGameState(state: GameState): GameState {
  state.config = normalizeConfig(state.config);
  if (state.paused == null) state.paused = false;
  if (state.pausedTurnRemainingMs === undefined) state.pausedTurnRemainingMs = null;
  if (state.timeBankStartedMs === undefined) state.timeBankStartedMs = null;
  if (state.timeBankExtensionMs === undefined) state.timeBankExtensionMs = null;
  if (!state.rabbitCards) state.rabbitCards = [];
  for (const seat of state.seats) {
    if (typeof seat.timeBankMs !== "number") seat.timeBankMs = 0;
  }
  // Grow seat ring if maxSeats increased (e.g. 9 → 10).
  while (state.seats.length < state.config.maxSeats) {
    const seatIndex = state.seats.length;
    state.seats.push({
      seatIndex,
      playerId: null,
      displayName: null,
      stack: 0,
      status: "empty",
      holeCards: null,
      betThisStreet: 0,
      committedThisHand: 0,
      hasActedThisStreet: false,
      timeBankMs: 0,
    });
  }
  return state;
}

function canDealPlayers(state: GameState): SeatState[] {
  return state.seats.filter(
    (s) =>
      s.playerId &&
      s.stack > 0 &&
      (s.status === "seated" || s.status === "waiting_next_hand" || s.status === "active"),
  );
}

function nextOccupiedSeat(state: GameState, from: number, predicate: (s: SeatState) => boolean): number | null {
  const n = state.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    const seat = state.seats[idx]!;
    if (predicate(seat)) return idx;
  }
  return null;
}

function playersToAct(state: GameState): SeatState[] {
  return state.seats.filter(
    (s) =>
      s.status === "active" &&
      s.stack > 0 &&
      (!s.hasActedThisStreet || s.betThisStreet < state.currentBet),
  );
}

function resetStreetFlags(state: GameState): void {
  for (const seat of state.seats) {
    seat.betThisStreet = 0;
    seat.hasActedThisStreet = false;
  }
  state.currentBet = 0;
  state.minRaise = state.config.bigBlind;
}

function postBlind(seat: SeatState, amount: number): number {
  const paid = Math.min(seat.stack, amount);
  seat.stack -= paid;
  seat.betThisStreet += paid;
  seat.committedThisHand += paid;
  if (seat.stack === 0) seat.status = "all_in";
  return paid;
}

export function startHand(state: GameState, nowMs: number): EngineEvent[] {
  const events: EngineEvent[] = [];
  if (state.paused || state.street !== "waiting") {
    return events;
  }
  if (state.pendingConfig) {
    state.config = promoteConfig(state.config, state.pendingConfig);
    state.pendingConfig = null;
    events.push({ type: "config_promoted", config: { ...state.config } });
  }

  const ready = canDealPlayers(state);
  if (ready.length < MIN_SEATS_TO_DEAL) {
    state.street = "waiting";
    state.actionSeat = null;
    state.turnDeadlineMs = null;
    state.timeBankStartedMs = null;
    state.timeBankExtensionMs = null;
    return events;
  }

  // Promote waiting_next_hand → active
  for (const seat of state.seats) {
    if (seat.playerId && seat.stack > 0 && (seat.status === "seated" || seat.status === "waiting_next_hand")) {
      seat.status = "active";
    }
    seat.holeCards = null;
    seat.betThisStreet = 0;
    seat.committedThisHand = 0;
    seat.hasActedThisStreet = false;
  }

  state.handNumber += 1;
  state.sequence += 1;
  state.board = [];
  state.pot = 0;
  state.lastHandResult = null;
  state.rabbitCards = [];
  state.timeBankStartedMs = null;
  state.timeBankExtensionMs = null;
  state.deck = shuffleDeck(buildDeck());
  state.street = "preflop";

  // Advance dealer among players in this hand
  const dealer = nextOccupiedSeat(
    state,
    state.dealerSeat,
    (s) => s.status === "active" || s.status === "all_in",
  );
  state.dealerSeat = dealer ?? state.dealerSeat;
  events.push({
    type: "hand_started",
    handNumber: state.handNumber,
    dealerSeat: state.dealerSeat,
  });

  const sbSeat = nextOccupiedSeat(
    state,
    state.dealerSeat,
    (s) => s.status === "active" || s.status === "all_in",
  );
  const bbSeat =
    sbSeat === null
      ? null
      : nextOccupiedSeat(state, sbSeat, (s) => s.status === "active" || s.status === "all_in");
  if (sbSeat === null || bbSeat === null) return events;

  const sbPaid = postBlind(state.seats[sbSeat]!, state.config.smallBlind);
  const bbPaid = postBlind(state.seats[bbSeat]!, state.config.bigBlind);
  state.pot = sbPaid + bbPaid;
  state.currentBet = Math.max(
    state.seats[sbSeat]!.betThisStreet,
    state.seats[bbSeat]!.betThisStreet,
  );
  state.minRaise = state.config.bigBlind;
  events.push({
    type: "blinds_posted",
    sb: sbPaid,
    bb: bbPaid,
    pot: state.pot,
  });

  // Deal two hole cards each
  for (const seat of state.seats) {
    if (seat.status === "active" || seat.status === "all_in") {
      const c1 = state.deck.pop();
      const c2 = state.deck.pop();
      if (!c1 || !c2) throw new Error("Deck exhausted");
      seat.holeCards = [c1, c2];
    }
  }
  events.push({ type: "dealt_hole" });

  const first =
    nextOccupiedSeat(state, bbSeat, (s) => s.status === "active" && s.stack > 0) ??
    nextOccupiedSeat(state, bbSeat, (s) => s.status === "active" || s.status === "all_in");
  state.actionSeat = first;
  if (first !== null) {
    events.push(...setTurnDeadline(state, nowMs, first));
  }
  return events;
}

function setTurnDeadline(state: GameState, nowMs: number, seatIndex: number | null): EngineEvent[] {
  state.timeBankStartedMs = null;
  state.timeBankExtensionMs = null;
  if (seatIndex === null) {
    state.turnDeadlineMs = null;
    return [];
  }
  state.turnDeadlineMs = nowMs + state.config.turnTimeoutMs;
  return [{ type: "turn", seatIndex, deadlineMs: state.turnDeadlineMs }];
}

export interface LegalActions {
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
}

export function getLegalActions(state: GameState, seatIndex: number): LegalActions | null {
  if (state.actionSeat !== seatIndex) return null;
  const seat = state.seats[seatIndex];
  if (!seat || seat.status !== "active") return null;

  const toCall = Math.max(0, state.currentBet - seat.betThisStreet);
  const potBeforeAction = state.pot;
  const cap = maxTargetWager(potBeforeAction, state.config.potCapMultiplier);
  const canCheck = toCall === 0;
  const canCall = toCall > 0 && seat.stack > toCall;
  const callAmount = Math.min(toCall, seat.stack);
  const canBet = state.currentBet === 0 && seat.stack > 0;
  const canRaise = state.currentBet > 0 && seat.stack > toCall;

  const minBet = state.config.bigBlind;
  const maxBet = Math.min(seat.stack, Math.max(minBet, cap - seat.betThisStreet));
  const minRaiseTo = state.currentBet + state.minRaise;
  const maxRaiseTo = Math.min(
    seat.betThisStreet + seat.stack,
    Math.max(minRaiseTo, cap),
  );

  return {
    canFold: true,
    canCheck,
    canCall,
    callAmount,
    canBet,
    canRaise,
    minBet,
    maxBet: Math.max(0, maxBet),
    minRaiseTo,
    maxRaiseTo,
    canAllIn: seat.stack > 0,
  };
}

function advanceAfterAction(state: GameState, nowMs: number): EngineEvent[] {
  const events: EngineEvent[] = [];
  const active = state.seats.filter((s) => s.status === "active" || s.status === "all_in");
  const inHand = state.seats.filter(
    (s) => s.status === "active" || s.status === "all_in" || s.status === "folded",
  );
  const notFolded = active;

  if (notFolded.length === 1) {
    return events.concat(completeHand(state, nowMs));
  }

  if (playersToAct(state).length === 0) {
    return events.concat(advanceStreet(state, nowMs));
  }

  const next = nextOccupiedSeat(
    state,
    state.actionSeat ?? state.dealerSeat,
    (s) =>
      s.status === "active" &&
      s.stack > 0 &&
      (!s.hasActedThisStreet || s.betThisStreet < state.currentBet),
  );
  state.actionSeat = next;
  if (next !== null) {
    events.push(...setTurnDeadline(state, nowMs, next));
  } else {
    setTurnDeadline(state, nowMs, null);
  }
  void inHand;
  return events;
}

function dealBoard(state: GameState, count: number): Card[] {
  const burn = state.deck.pop();
  if (!burn) throw new Error("Deck exhausted");
  const cards: Card[] = [];
  for (let i = 0; i < count; i++) {
    const c = state.deck.pop();
    if (!c) throw new Error("Deck exhausted");
    cards.push(c);
  }
  state.board.push(...cards);
  return cards;
}

function advanceStreet(state: GameState, nowMs: number): EngineEvent[] {
  const events: EngineEvent[] = [];
  resetStreetFlags(state);

  if (state.street === "preflop") {
    state.street = "flop";
    const cards = dealBoard(state, 3);
    events.push({ type: "board", street: "flop", cards });
  } else if (state.street === "flop") {
    state.street = "turn";
    const cards = dealBoard(state, 1);
    events.push({ type: "board", street: "turn", cards });
  } else if (state.street === "turn") {
    state.street = "river";
    const cards = dealBoard(state, 1);
    events.push({ type: "board", street: "river", cards });
  } else if (state.street === "river") {
    return events.concat(completeHand(state, nowMs));
  }

  const still = state.seats.filter((s) => s.status === "active" && s.stack > 0);
  if (still.length <= 1) {
    // Run out remaining board then showdown
    while (state.board.length < 5) {
      if (state.board.length === 0) {
        state.street = "flop";
        events.push({ type: "board", street: "flop", cards: dealBoard(state, 3) });
      } else if (state.board.length === 3) {
        state.street = "turn";
        events.push({ type: "board", street: "turn", cards: dealBoard(state, 1) });
      } else if (state.board.length === 4) {
        state.street = "river";
        events.push({ type: "board", street: "river", cards: dealBoard(state, 1) });
      } else break;
    }
    return events.concat(completeHand(state, nowMs));
  }

  const first = nextOccupiedSeat(
    state,
    state.dealerSeat,
    (s) => s.status === "active" && s.stack > 0,
  );
  state.actionSeat = first;
  if (first !== null) {
    events.push(...setTurnDeadline(state, nowMs, first));
  } else {
    setTurnDeadline(state, nowMs, null);
  }
  return events;
}

function completeHand(state: GameState, _nowMs: number): EngineEvent[] {
  void _nowMs;
  state.street = "showdown";
  state.actionSeat = null;
  state.turnDeadlineMs = null;

  const contributions = new Map<string, number>();
  for (const seat of state.seats) {
    if (seat.playerId && seat.committedThisHand > 0) {
      contributions.set(seat.playerId, seat.committedThisHand);
    }
  }
  const eligible = state.seats
    .filter((s) => s.playerId && (s.status === "active" || s.status === "all_in"))
    .map((s) => s.playerId!);

  const pots = computeSidePots(contributions, eligible);
  const winners: HandResult["winners"] = [];
  const shownHands: HandResult["shownHands"] = [];

  for (const seat of state.seats) {
    if (seat.playerId && seat.holeCards && (seat.status === "active" || seat.status === "all_in")) {
      shownHands.push({ playerId: seat.playerId, cards: seat.holeCards });
    }
  }

  pots.forEach((pot, potIndex) => {
    if (pot.eligiblePlayerIds.length === 0 || pot.amount <= 0) return;
    if (pot.eligiblePlayerIds.length === 1) {
      const pid = pot.eligiblePlayerIds[0]!;
      const seat = state.seats.find((s) => s.playerId === pid);
      if (seat) seat.stack += pot.amount;
      winners.push({ playerId: pid, amount: pot.amount, potIndex });
      return;
    }
    const evaluated = pot.eligiblePlayerIds.map((pid) => {
      const seat = state.seats.find((s) => s.playerId === pid)!;
      const hand = evaluateBestHand([...(seat.holeCards ?? []), ...state.board]);
      return { pid, hand };
    });
    evaluated.sort((a, b) => compareHands(b.hand, a.hand));
    const best = evaluated[0]!.hand;
    const tied = evaluated.filter((e) => compareHands(e.hand, best) === 0);
    const winningHand: WinningHandInfo = {
      category: best.category,
      label: categoryDisplayLabel(best),
      bestFive: best.bestFive,
      strength: best.ranks,
    };
    const share = Math.floor(pot.amount / tied.length);
    let remainder = pot.amount - share * tied.length;
    for (const t of tied) {
      const seat = state.seats.find((s) => s.playerId === t.pid)!;
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      const amount = share + extra;
      seat.stack += amount;
      winners.push({ playerId: t.pid, amount, potIndex, hand: winningHand });
    }
  });

  state.pot = 0;
  const result: HandResult = { winners, pots, shownHands };
  state.lastHandResult = result;
  state.sequence += 1;
  state.timeBankStartedMs = null;
  state.timeBankExtensionMs = null;
  state.rabbitCards = [];

  for (const seat of state.seats) {
    if (!seat.playerId) continue;
    seat.holeCards = null;
    seat.betThisStreet = 0;
    seat.committedThisHand = 0;
    seat.hasActedThisStreet = false;
    if (seat.stack <= 0) {
      seat.status = "sitting_out";
    } else {
      seat.status = "seated";
    }
  }
  state.street = "waiting";
  return [{ type: "hand_complete", result }];
}

export function applyAction(
  state: GameState,
  seatIndex: number,
  action: ActionType,
  amount: number | undefined,
  nowMs: number,
  idempotencyKey: string,
): { ok: true; events: EngineEvent[]; idempotencyKey: string } | { ok: false; error: string } {
  void idempotencyKey;
  if (state.paused) return { ok: false, error: "The table is paused." };
  settleTimeBankOnAction(state, seatIndex, nowMs);
  const legal = getLegalActions(state, seatIndex);
  if (!legal) return { ok: false, error: "Not your turn." };
  const seat = state.seats[seatIndex]!;
  let paid = 0;
  let resolved: ActionType = action;

  switch (action) {
    case "fold": {
      seat.status = "folded";
      seat.hasActedThisStreet = true;
      break;
    }
    case "check": {
      if (!legal.canCheck) return { ok: false, error: "Cannot check." };
      seat.hasActedThisStreet = true;
      break;
    }
    case "call": {
      if (!legal.canCall && !(legal.callAmount > 0 && legal.canAllIn)) {
        return { ok: false, error: "Cannot call." };
      }
      paid = Math.min(legal.callAmount, seat.stack);
      seat.stack -= paid;
      seat.betThisStreet += paid;
      seat.committedThisHand += paid;
      state.pot += paid;
      seat.hasActedThisStreet = true;
      if (seat.stack === 0) {
        seat.status = "all_in";
        resolved = "all_in";
      }
      break;
    }
    case "bet": {
      if (!legal.canBet) return { ok: false, error: "Cannot bet." };
      const target = amount ?? legal.minBet;
      if (target < legal.minBet) return { ok: false, error: "Bet below minimum." };
      const capped = Math.min(target, legal.maxBet, seat.stack);
      // Allow all-in shove even above pot-cap
      const wantAllIn = amount !== undefined && amount >= seat.stack;
      paid = wantAllIn ? seat.stack : capped;
      if (!wantAllIn && paid < legal.minBet) return { ok: false, error: "Bet below minimum." };
      seat.stack -= paid;
      seat.betThisStreet += paid;
      seat.committedThisHand += paid;
      state.pot += paid;
      state.minRaise = Math.max(state.minRaise, paid - state.currentBet);
      state.currentBet = seat.betThisStreet;
      seat.hasActedThisStreet = true;
      // reopen action
      for (const s of state.seats) {
        if (s.seatIndex !== seatIndex && s.status === "active") s.hasActedThisStreet = false;
      }
      if (seat.stack === 0) {
        seat.status = "all_in";
        resolved = "all_in";
      }
      break;
    }
    case "raise": {
      if (!legal.canRaise && !legal.canAllIn) return { ok: false, error: "Cannot raise." };
      const raiseTo = amount ?? legal.minRaiseTo;
      const wantAllIn = raiseTo >= seat.betThisStreet + seat.stack;
      let target = raiseTo;
      if (!wantAllIn) {
        if (raiseTo < legal.minRaiseTo) return { ok: false, error: "Raise below minimum." };
        target = Math.min(raiseTo, legal.maxRaiseTo);
      }
      paid = Math.min(target - seat.betThisStreet, seat.stack);
      if (paid <= 0) return { ok: false, error: "Invalid raise." };
      const raiseSize = seat.betThisStreet + paid - state.currentBet;
      seat.stack -= paid;
      seat.betThisStreet += paid;
      seat.committedThisHand += paid;
      state.pot += paid;
      if (raiseSize > 0) state.minRaise = Math.max(state.minRaise, raiseSize);
      state.currentBet = Math.max(state.currentBet, seat.betThisStreet);
      seat.hasActedThisStreet = true;
      for (const s of state.seats) {
        if (s.seatIndex !== seatIndex && s.status === "active") s.hasActedThisStreet = false;
      }
      if (seat.stack === 0) {
        seat.status = "all_in";
        resolved = "all_in";
      }
      break;
    }
    case "all_in": {
      paid = seat.stack;
      if (paid <= 0) return { ok: false, error: "Nothing to shove." };
      const newBet = seat.betThisStreet + paid;
      const raiseSize = newBet - state.currentBet;
      seat.stack = 0;
      seat.betThisStreet = newBet;
      seat.committedThisHand += paid;
      state.pot += paid;
      if (newBet > state.currentBet) {
        state.minRaise = Math.max(state.minRaise, raiseSize);
        state.currentBet = newBet;
        for (const s of state.seats) {
          if (s.seatIndex !== seatIndex && s.status === "active") s.hasActedThisStreet = false;
        }
      }
      seat.status = "all_in";
      seat.hasActedThisStreet = true;
      break;
    }
    default:
      return { ok: false, error: "Unknown action." };
  }

  state.sequence += 1;
  const events: EngineEvent[] = [
    {
      type: "action",
      playerId: seat.playerId!,
      action: resolved,
      amount: paid,
      pot: state.pot,
    },
  ];
  return {
    ok: true,
    events: events.concat(advanceAfterAction(state, nowMs)),
    idempotencyKey,
  };
}

export function seatPlayer(
  state: GameState,
  playerId: string,
  displayName: string,
  seatIndex: number,
): { ok: true } | { ok: false; error: string } {
  const seat = state.seats[seatIndex];
  if (!seat) return { ok: false, error: "Invalid seat." };
  if (seat.playerId) return { ok: false, error: "That seat is taken." };
  if (state.seats.some((s) => s.playerId === playerId)) {
    return { ok: false, error: "Already seated." };
  }
  seat.playerId = playerId;
  seat.displayName = displayName;
  seat.stack = state.config.startingStack;
  seat.timeBankMs = (state.config.timeBankSeconds ?? 60) * 1000;
  seat.status = state.street === "waiting" ? "seated" : "waiting_next_hand";
  state.sequence += 1;
  return { ok: true };
}

function clearSeat(seat: SeatState): void {
  seat.playerId = null;
  seat.displayName = null;
  seat.stack = 0;
  seat.status = "empty";
  seat.holeCards = null;
  seat.betThisStreet = 0;
  seat.committedThisHand = 0;
  seat.hasActedThisStreet = false;
  seat.timeBankMs = 0;
}

/**
 * Remove a player from their seat. Mid-hand: fold if still active and defer
 * clearing the seat until the hand returns to waiting (preserves pot math).
 */
export function unseatPlayer(
  state: GameState,
  playerId: string,
  nowMs: number,
):
  | { ok: true; events: EngineEvent[]; deferred: boolean }
  | { ok: false; error: string } {
  const seat = state.seats.find((s) => s.playerId === playerId);
  if (!seat) return { ok: false, error: "Player is not seated." };

  const events: EngineEvent[] = [];
  const inHand =
    state.street !== "waiting" &&
    (seat.status === "active" || seat.status === "all_in" || seat.status === "folded");

  if (inHand && seat.status === "active") {
    const fold = applyAction(
      state,
      seat.seatIndex,
      "fold",
      undefined,
      nowMs,
      `leave:${playerId}:${state.sequence}`,
    );
    if (fold.ok) events.push(...fold.events);
  }

  // Hand may have completed via the fold.
  if (state.street !== "waiting") {
    const still = state.seats.find((s) => s.playerId === playerId);
    if (still) {
      still.displayName = `${still.displayName ?? "Player"} (left)`;
    }
    state.sequence += 1;
    return { ok: true, events, deferred: true };
  }

  const still = state.seats.find((s) => s.playerId === playerId);
  if (still) clearSeat(still);
  state.sequence += 1;
  return { ok: true, events, deferred: false };
}

/** Clear seats marked for deferred leave once the table is between hands. */
export function flushDeferredLeaves(state: GameState, playerIds: string[]): void {
  if (state.street !== "waiting") return;
  for (const id of playerIds) {
    const seat = state.seats.find((s) => s.playerId === id);
    if (seat) clearSeat(seat);
  }
  if (playerIds.length) state.sequence += 1;
}

/** Play-money stack reset for a busted (0-chip) seated player. */
export function rebuyPlayer(
  state: GameState,
  playerId: string,
  chips?: number,
): { ok: true } | { ok: false; error: string } {
  const seat = state.seats.find((s) => s.playerId === playerId);
  if (!seat) return { ok: false, error: "Player is not seated." };
  if (seat.stack > 0) {
    return { ok: false, error: "Rebuy is only for busted seats (0 chips)." };
  }
  if (state.street !== "waiting" && seat.status !== "sitting_out" && seat.status !== "waiting_next_hand" && seat.status !== "seated") {
    return { ok: false, error: "Wait until the hand finishes before rebuying." };
  }
  const amount = chips ?? state.config.startingStack;
  if (!Number.isInteger(amount) || amount < state.config.startingStack || amount > 1000) {
    return {
      ok: false,
      error: `Rebuy must be between ${state.config.startingStack} and 1000 virtual chips.`,
    };
  }
  seat.stack = amount;
  seat.status = state.street === "waiting" ? "seated" : "waiting_next_hand";
  state.sequence += 1;
  return { ok: true };
}

/** Mark away / return without removing the seat. Does not cancel turn timers. */
export function setPlayerAway(
  state: GameState,
  playerId: string,
  away: boolean,
): { ok: true } | { ok: false; error: string } {
  const seat = state.seats.find((s) => s.playerId === playerId);
  if (!seat) return { ok: false, error: "Player is not seated." };
  if (away) {
    if (state.street !== "waiting" && (seat.status === "active" || seat.status === "all_in")) {
      // Stay in the hand; mark sitting_out only between hands.
      return { ok: false, error: "Finish this hand before going away." };
    }
    seat.status = "sitting_out";
  } else {
    if (seat.status !== "sitting_out") {
      return { ok: false, error: "You are not marked away." };
    }
    seat.status = state.street === "waiting" ? "seated" : "waiting_next_hand";
  }
  state.sequence += 1;
  return { ok: true };
}

export function projectForPlayer(state: GameState, viewerId: string | null) {
  return {
    config: state.config,
    pendingConfig: state.pendingConfig,
    street: state.street,
    board: state.board,
    pot: state.pot,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    dealerSeat: state.dealerSeat,
    actionSeat: state.actionSeat,
    handNumber: state.handNumber,
    sequence: state.sequence,
    turnDeadlineMs: state.turnDeadlineMs,
    paused: Boolean(state.paused),
    timeBankActive: state.timeBankStartedMs != null,
    rabbitCards: state.rabbitCards ?? [],
    lastHandResult: state.lastHandResult,
    seats: state.seats.map((s) => ({
      seatIndex: s.seatIndex,
      playerId: s.playerId,
      displayName: s.displayName,
      stack: s.stack,
      status: s.status,
      betThisStreet: s.betThisStreet,
      timeBankMs: s.timeBankMs ?? 0,
      holeCards:
        s.playerId && s.playerId === viewerId
          ? s.holeCards
          : state.street === "showdown" || state.lastHandResult
            ? state.lastHandResult?.shownHands.find((h) => h.playerId === s.playerId)?.cards ??
              null
            : null,
      isViewer: s.playerId === viewerId,
    })),
    legalActions:
      viewerId && state.actionSeat !== null && !state.paused
        ? (() => {
            const seat = state.seats[state.actionSeat!];
            if (seat?.playerId === viewerId) return getLegalActions(state, state.actionSeat!);
            return null;
          })()
        : null,
    /** True when viewer has room access but no seat (true spectator). */
    isSpectator: Boolean(viewerId && !state.seats.some((s) => s.playerId === viewerId)),
  };
}

export type PublicGameView = ReturnType<typeof projectForPlayer>;

/** Refund unused time bank after an action during the bank phase. */
export function settleTimeBankOnAction(
  state: GameState,
  seatIndex: number,
  nowMs: number,
): void {
  if (state.timeBankStartedMs == null || state.timeBankExtensionMs == null) return;
  if (state.actionSeat !== seatIndex) return;
  const seat = state.seats[seatIndex];
  if (!seat) return;
  const used = Math.max(0, nowMs - state.timeBankStartedMs);
  const unused = Math.max(0, state.timeBankExtensionMs - used);
  seat.timeBankMs = (seat.timeBankMs ?? 0) + unused;
  state.timeBankStartedMs = null;
  state.timeBankExtensionMs = null;
}

/**
 * Primary turn timer expired. Consume time bank before auto fold/check.
 * Returns { kind: 'bank' } if bank extended the turn, or { kind: 'timeout' } to auto-act.
 */
export function onTurnTimerExpired(
  state: GameState,
  nowMs: number,
):
  | { kind: "bank"; events: EngineEvent[] }
  | { kind: "timeout" }
  | { kind: "noop" } {
  if (state.paused || state.actionSeat === null) return { kind: "noop" };
  const seat = state.seats[state.actionSeat];
  if (!seat || seat.status !== "active") return { kind: "noop" };

  // Already in bank phase — bank exhausted.
  if (state.timeBankStartedMs != null) {
    state.timeBankStartedMs = null;
    state.timeBankExtensionMs = null;
    return { kind: "timeout" };
  }

  const bank = seat.timeBankMs ?? 0;
  if (bank > 0) {
    seat.timeBankMs = 0;
    state.timeBankStartedMs = nowMs;
    state.timeBankExtensionMs = bank;
    state.turnDeadlineMs = nowMs + bank;
    state.sequence += 1;
    return {
      kind: "bank",
      events: [
        {
          type: "time_bank",
          seatIndex: seat.seatIndex,
          remainingMs: bank,
          deadlineMs: state.turnDeadlineMs,
        },
      ],
    };
  }
  return { kind: "timeout" };
}

export function setPaused(
  state: GameState,
  paused: boolean,
  nowMs: number,
): { ok: true; events: EngineEvent[] } | { ok: false; error: string } {
  if (paused === state.paused) {
    return { ok: true, events: [] };
  }
  if (paused) {
    state.paused = true;
    if (state.turnDeadlineMs != null) {
      state.pausedTurnRemainingMs = Math.max(0, state.turnDeadlineMs - nowMs);
      state.turnDeadlineMs = null;
    } else {
      state.pausedTurnRemainingMs = null;
    }
  } else {
    state.paused = false;
    if (state.pausedTurnRemainingMs != null && state.actionSeat !== null) {
      state.turnDeadlineMs = nowMs + state.pausedTurnRemainingMs;
      state.pausedTurnRemainingMs = null;
    } else {
      state.pausedTurnRemainingMs = null;
    }
  }
  state.sequence += 1;
  return { ok: true, events: [{ type: "paused", paused: state.paused }] };
}

/**
 * Reveal remaining undealt board cards after a hand ends (play-money fun only).
 * Only undealt streets — never invents cards if the board already has 5.
 */
export function rabbitHunt(
  state: GameState,
): { ok: true; events: EngineEvent[]; cards: Card[] } | { ok: false; error: string } {
  if (state.street !== "waiting") {
    return { ok: false, error: "Rabbit hunt is only available between hands." };
  }
  if (!state.lastHandResult) {
    return { ok: false, error: "No hand to rabbit." };
  }
  if (state.rabbitCards.length > 0) {
    return { ok: true, events: [], cards: state.rabbitCards };
  }
  const need = 5 - state.board.length;
  if (need <= 0) {
    return { ok: false, error: "The full board was already dealt." };
  }
  if (state.deck.length < need) {
    return { ok: false, error: "No undealt cards left." };
  }
  const cards = state.deck.splice(0, need);
  state.rabbitCards = cards;
  state.sequence += 1;
  return { ok: true, events: [{ type: "rabbit", cards }], cards };
}