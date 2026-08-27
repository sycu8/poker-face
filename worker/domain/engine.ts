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
  /**
   * Bet level (`currentBet`) at which this seat last completed an action this street.
   * `null` = has not acted yet this street (or street was reset).
   * Used for no-limit raise-reopen semantics.
   */
  actedAtBetLevel: number | null;
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
  /** True when pause interrupted an active time-bank burn. */
  pausedDuringTimeBank: boolean;
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
    actedAtBetLevel: null,
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
    pausedDuringTimeBank: false,
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
  if (state.pausedDuringTimeBank == null) state.pausedDuringTimeBank = false;
  if (!state.rabbitCards) state.rabbitCards = [];
  for (const seat of state.seats) {
    if (typeof seat.timeBankMs !== "number") seat.timeBankMs = 0;
    // Migrate legacy hasActedThisStreet snapshots.
    const legacy = seat as SeatState & { hasActedThisStreet?: boolean };
    if (
      !("actedAtBetLevel" in seat) ||
      (seat.actedAtBetLevel === undefined &&
        typeof legacy.hasActedThisStreet === "boolean")
    ) {
      seat.actedAtBetLevel = legacy.hasActedThisStreet ? seat.betThisStreet : null;
    } else if (seat.actedAtBetLevel === undefined) {
      seat.actedAtBetLevel = null;
    }
    delete legacy.hasActedThisStreet;
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
      actedAtBetLevel: null,
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
      (s.status === "seated" ||
        s.status === "waiting_next_hand" ||
        s.status === "active"),
  );
}

function nextOccupiedSeat(
  state: GameState,
  from: number,
  predicate: (s: SeatState) => boolean,
): number | null {
  const n = state.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    const seat = state.seats[idx]!;
    if (predicate(seat)) return idx;
  }
  return null;
}

function liveInHand(s: SeatState): boolean {
  return s.status === "active" || s.status === "all_in";
}

function playersToAct(state: GameState): SeatState[] {
  return state.seats.filter(
    (s) =>
      s.status === "active" &&
      s.stack > 0 &&
      (s.actedAtBetLevel === null || s.betThisStreet < state.currentBet),
  );
}

/** Raise rights reopen only after facing ≥ one full legal raise since last action. */
export function raiseRightsOpen(state: GameState, seat: SeatState): boolean {
  if (seat.actedAtBetLevel === null) return true;
  return state.currentBet - seat.actedAtBetLevel >= state.minRaise;
}

function resetStreetFlags(state: GameState): void {
  for (const seat of state.seats) {
    seat.betThisStreet = 0;
    seat.actedAtBetLevel = null;
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

/** Count players dealt into the current hand (active or all-in). */
function handPlayerCount(state: GameState): number {
  return state.seats.filter((s) => liveInHand(s)).length;
}

/**
 * After blinds / actions: if ≤1 player can still make a betting decision and
 * ≥2 live hands remain, auto-run the remaining board to showdown.
 */
function maybeAutoRunout(state: GameState, nowMs: number): EngineEvent[] | null {
  const live = state.seats.filter((s) => liveInHand(s));
  if (live.length < 2) return null;
  const actionable = state.seats.filter((s) => s.status === "active" && s.stack > 0);
  if (actionable.length > 1) return null;
  // One or zero actionable players with chips — no meaningful betting remains.
  if (actionable.length === 1 && playersToAct(state).length > 0) {
    // The single actionable player still faces a decision (e.g. call short all-in).
    return null;
  }
  if (actionable.length === 1 && playersToAct(state).length === 0) {
    return runOutBoardAndComplete(state, nowMs);
  }
  if (actionable.length === 0) {
    return runOutBoardAndComplete(state, nowMs);
  }
  return null;
}

function runOutBoardAndComplete(state: GameState, nowMs: number): EngineEvent[] {
  const events: EngineEvent[] = [];
  state.actionSeat = null;
  setTurnDeadline(state, nowMs, null);
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
    if (
      seat.playerId &&
      seat.stack > 0 &&
      (seat.status === "seated" || seat.status === "waiting_next_hand")
    ) {
      seat.status = "active";
    }
    seat.holeCards = null;
    seat.betThisStreet = 0;
    seat.committedThisHand = 0;
    seat.actedAtBetLevel = null;
  }

  state.handNumber += 1;
  state.sequence += 1;
  state.board = [];
  state.pot = 0;
  state.lastHandResult = null;
  state.rabbitCards = [];
  state.timeBankStartedMs = null;
  state.timeBankExtensionMs = null;
  state.pausedDuringTimeBank = false;
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

  const inHand = handPlayerCount(state);
  let sbSeat: number | null;
  let bbSeat: number | null;
  if (inHand === 2) {
    // Heads-up: button posts SB; other posts BB.
    sbSeat = state.dealerSeat;
    bbSeat = nextOccupiedSeat(state, state.dealerSeat, (s) => liveInHand(s));
  } else {
    sbSeat = nextOccupiedSeat(state, state.dealerSeat, (s) => liveInHand(s));
    bbSeat =
      sbSeat === null ? null : nextOccupiedSeat(state, sbSeat, (s) => liveInHand(s));
  }
  if (sbSeat === null || bbSeat === null) return events;

  const sbPaid = postBlind(state.seats[sbSeat]!, state.config.smallBlind);
  const bbPaid = postBlind(state.seats[bbSeat]!, state.config.bigBlind);
  state.pot = sbPaid + bbPaid;
  // Multiway short-BB: opening level remains the configured full big blind.
  // Heads-up short-BB: face the amount actually contested.
  if (inHand === 2) {
    state.currentBet = Math.max(
      state.seats[sbSeat]!.betThisStreet,
      state.seats[bbSeat]!.betThisStreet,
    );
  } else {
    state.currentBet = state.config.bigBlind;
  }
  state.minRaise = state.config.bigBlind;
  // Blind posts are not voluntary actions — leave actedAtBetLevel null so
  // SB/button can open and BB retains preflop option.
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

  const auto = maybeAutoRunout(state, nowMs);
  if (auto) return events.concat(auto);

  // Preflop: first to act is left of BB (HU: button/SB).
  const first =
    nextOccupiedSeat(state, bbSeat, (s) => s.status === "active" && s.stack > 0) ??
    nextOccupiedSeat(
      state,
      bbSeat,
      (s) => s.status === "active" || s.status === "all_in",
    );
  state.actionSeat = first;
  if (first !== null) {
    events.push(...setTurnDeadline(state, nowMs, first));
  }
  return events;
}

function setTurnDeadline(
  state: GameState,
  nowMs: number,
  seatIndex: number | null,
): EngineEvent[] {
  state.timeBankStartedMs = null;
  state.timeBankExtensionMs = null;
  state.pausedDuringTimeBank = false;
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
  /** True when calling consumes the entire stack. */
  callIsAllIn: boolean;
  canBet: boolean;
  canRaise: boolean;
  /** Raise rights open but stack only covers a short all-in increase. */
  canShortAllInRaise: boolean;
  minBet: number;
  maxBet: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  canAllIn: boolean;
  allInAmount: number;
}

export function getLegalActions(
  state: GameState,
  seatIndex: number,
): LegalActions | null {
  if (state.actionSeat !== seatIndex) return null;
  const seat = state.seats[seatIndex];
  if (!seat || seat.status !== "active") return null;

  const toCall = Math.max(0, state.currentBet - seat.betThisStreet);
  const potBeforeAction = state.pot;
  const cap = maxTargetWager(potBeforeAction, state.config.potCapMultiplier);
  const canCheck = toCall === 0;
  // Calling remains possible whenever there is something to call and chips remain,
  // including exact-stack and short all-in calls.
  const canCall = toCall > 0 && seat.stack > 0;
  const callAmount = Math.min(toCall, seat.stack);
  const callIsAllIn = canCall && callAmount >= seat.stack;

  const rights = raiseRightsOpen(state, seat);
  const maxRaiseToRaw = Math.min(
    seat.betThisStreet + seat.stack,
    Math.max(state.currentBet, cap),
  );
  const minRaiseTo = state.currentBet + state.minRaise;
  const maxRaiseTo = maxRaiseToRaw;
  const fullRaisePossible = rights && seat.stack > toCall && minRaiseTo <= maxRaiseTo;
  const shortAllInRaisePossible =
    rights &&
    seat.stack > toCall &&
    seat.betThisStreet + seat.stack > state.currentBet &&
    seat.betThisStreet + seat.stack < minRaiseTo;

  const canBet = state.currentBet === 0 && seat.stack > 0 && rights;
  const canRaise = state.currentBet > 0 && fullRaisePossible;
  const canShortAllInRaise = state.currentBet > 0 && shortAllInRaisePossible;

  const minBet = state.config.bigBlind;
  const maxBet = Math.min(seat.stack, Math.max(minBet, cap - seat.betThisStreet));

  // Generic all-in: call-all-in, open shove, or legal raise shove — never bypass closed rights.
  let canAllIn = false;
  if (seat.stack > 0) {
    if (toCall > 0 && seat.stack <= toCall) {
      canAllIn = true; // call all-in
    } else if (toCall === 0) {
      canAllIn = true; // open shove / bet all-in
    } else if (rights && seat.stack > toCall) {
      canAllIn = true; // raise all-in (full or short) with open rights
    }
  }

  // Invariant: never advertise canRaise when min > max.
  const safeCanRaise = canRaise && minRaiseTo <= maxRaiseTo;

  return {
    canFold: true,
    canCheck,
    canCall,
    callAmount,
    callIsAllIn,
    canBet,
    canRaise: safeCanRaise,
    canShortAllInRaise,
    minBet,
    maxBet: Math.max(0, maxBet),
    minRaiseTo,
    maxRaiseTo: Math.max(0, maxRaiseTo),
    canAllIn,
    allInAmount: seat.stack,
  };
}

function advanceAfterAction(state: GameState, nowMs: number): EngineEvent[] {
  const events: EngineEvent[] = [];
  const live = state.seats.filter((s) => liveInHand(s));

  if (live.length === 1) {
    return events.concat(completeHand(state, nowMs));
  }

  const auto = maybeAutoRunout(state, nowMs);
  if (auto) return events.concat(auto);

  if (playersToAct(state).length === 0) {
    return events.concat(advanceStreet(state, nowMs));
  }

  const next = nextOccupiedSeat(
    state,
    state.actionSeat ?? state.dealerSeat,
    (s) =>
      s.status === "active" &&
      s.stack > 0 &&
      (s.actedAtBetLevel === null || s.betThisStreet < state.currentBet),
  );
  state.actionSeat = next;
  if (next !== null) {
    events.push(...setTurnDeadline(state, nowMs, next));
  } else {
    setTurnDeadline(state, nowMs, null);
  }
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
    // Board street above may already be dealt; run out the rest then showdown.
    const more: EngineEvent[] = [];
    while (state.board.length < 5) {
      if (state.board.length === 0) {
        state.street = "flop";
        more.push({ type: "board", street: "flop", cards: dealBoard(state, 3) });
      } else if (state.board.length === 3) {
        state.street = "turn";
        more.push({ type: "board", street: "turn", cards: dealBoard(state, 1) });
      } else if (state.board.length === 4) {
        state.street = "river";
        more.push({ type: "board", street: "river", cards: dealBoard(state, 1) });
      } else break;
    }
    return events.concat(more).concat(completeHand(state, nowMs));
  }

  // Postflop: first to act is left of button (HU: BB).
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

/**
 * Award odd chips clockwise from the button among tied winners.
 * `tied` is unordered; we sort by clockwise seat distance from dealer.
 */
function awardOddChipsClockwise(
  state: GameState,
  tiedPlayerIds: string[],
  potAmount: number,
): Array<{ playerId: string; amount: number }> {
  const n = state.seats.length;
  const ordered = [...tiedPlayerIds].sort((a, b) => {
    const seatA = state.seats.find((s) => s.playerId === a)!.seatIndex;
    const seatB = state.seats.find((s) => s.playerId === b)!.seatIndex;
    const distA = (seatA - state.dealerSeat + n) % n;
    const distB = (seatB - state.dealerSeat + n) % n;
    // TDA / standard Hold'em: first odd chip goes to the first eligible
    // tied winner clockwise LEFT of the button (positive distance).
    // Distance 0 (button) sorts last for odd-chip priority.
    const rank = (d: number) => (d === 0 ? n : d);
    return rank(distA) - rank(distB);
  });
  const share = Math.floor(potAmount / ordered.length);
  let remainder = potAmount - share * ordered.length;
  return ordered.map((playerId) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { playerId, amount: share + extra };
  });
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
    if (
      seat.playerId &&
      seat.holeCards &&
      (seat.status === "active" || seat.status === "all_in")
    ) {
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
    const awards = awardOddChipsClockwise(
      state,
      tied.map((t) => t.pid),
      pot.amount,
    );
    for (const award of awards) {
      const seat = state.seats.find((s) => s.playerId === award.playerId)!;
      const ev = tied.find((t) => t.pid === award.playerId)!;
      // Each tied winner keeps their own best-five metadata.
      const winningHand: WinningHandInfo = {
        category: ev.hand.category,
        label: categoryDisplayLabel(ev.hand),
        bestFive: ev.hand.bestFive,
        strength: ev.hand.ranks,
      };
      seat.stack += award.amount;
      winners.push({
        playerId: award.playerId,
        amount: award.amount,
        potIndex,
        hand: winningHand,
      });
    }
  });

  state.pot = 0;
  const result: HandResult = { winners, pots, shownHands };
  state.lastHandResult = result;
  state.sequence += 1;
  state.timeBankStartedMs = null;
  state.timeBankExtensionMs = null;
  state.pausedDuringTimeBank = false;
  // Keep deck for rabbit hunt; clear hole cards from seats after showdown projection.
  state.rabbitCards = [];

  for (const seat of state.seats) {
    if (!seat.playerId) continue;
    seat.holeCards = null;
    seat.betThisStreet = 0;
    seat.committedThisHand = 0;
    seat.actedAtBetLevel = null;
    if (seat.stack <= 0) {
      seat.status = "sitting_out";
    } else {
      seat.status = "seated";
    }
  }
  state.street = "waiting";
  return [{ type: "hand_complete", result }];
}

/**
 * Apply a wager increase that may be a full raise or short all-in.
 * Updates minRaise only on full legal raises; never reduces minRaise.
 */
function applyWagerIncrease(state: GameState, seat: SeatState, paid: number): void {
  const previousBet = state.currentBet;
  const newBet = seat.betThisStreet + paid;
  const raiseSize = newBet - previousBet;
  seat.stack -= paid;
  seat.betThisStreet = newBet;
  seat.committedThisHand += paid;
  state.pot += paid;
  if (newBet > previousBet) {
    if (raiseSize >= state.minRaise) {
      state.minRaise = raiseSize;
    }
    state.currentBet = newBet;
  }
  seat.actedAtBetLevel = state.currentBet;
  if (seat.stack === 0) seat.status = "all_in";
}

export function applyAction(
  state: GameState,
  seatIndex: number,
  action: ActionType,
  amount: number | undefined,
  nowMs: number,
  idempotencyKey: string,
):
  | { ok: true; events: EngineEvent[]; idempotencyKey: string }
  | { ok: false; error: string } {
  void idempotencyKey;
  if (state.paused) return { ok: false, error: "The table is paused." };

  // Validate FIRST — invalid actions must not mutate the time bank.
  const legal = getLegalActions(state, seatIndex);
  if (!legal) return { ok: false, error: "Not your turn." };
  const seat = state.seats[seatIndex]!;

  // Pre-validate action legality before any mutation.
  const precheck = precheckAction(legal, seat, state, action, amount);
  if (!precheck.ok) return precheck;

  settleTimeBankOnAction(state, seatIndex, nowMs);

  let paid = 0;
  let resolved: ActionType = action;

  switch (action) {
    case "fold": {
      seat.status = "folded";
      seat.actedAtBetLevel = state.currentBet;
      break;
    }
    case "check": {
      seat.actedAtBetLevel = state.currentBet;
      break;
    }
    case "call": {
      paid = Math.min(legal.callAmount, seat.stack);
      seat.stack -= paid;
      seat.betThisStreet += paid;
      seat.committedThisHand += paid;
      state.pot += paid;
      seat.actedAtBetLevel = state.currentBet;
      if (seat.stack === 0) {
        seat.status = "all_in";
        resolved = "all_in";
      }
      break;
    }
    case "bet": {
      const target = amount ?? legal.minBet;
      const wantAllIn = amount !== undefined && amount >= seat.stack + seat.betThisStreet;
      if (wantAllIn || (amount !== undefined && amount >= seat.stack)) {
        paid = seat.stack;
      } else {
        const capped = Math.min(target, legal.maxBet, seat.stack);
        if (capped < legal.minBet && capped < seat.stack) {
          return { ok: false, error: "Bet below minimum." };
        }
        paid = capped;
      }
      if (paid <= 0) return { ok: false, error: "Invalid bet." };
      applyWagerIncrease(state, seat, paid);
      if (seat.status === "all_in") resolved = "all_in";
      break;
    }
    case "raise": {
      const raiseTo = amount ?? legal.minRaiseTo;
      const maxStackTo = seat.betThisStreet + seat.stack;
      const wantAllIn = raiseTo >= maxStackTo;
      if (!legal.canRaise && !legal.canShortAllInRaise) {
        return { ok: false, error: "Cannot raise." };
      }
      if (wantAllIn) {
        if (!legal.canRaise && !legal.canShortAllInRaise && !legal.canAllIn) {
          return { ok: false, error: "Cannot raise." };
        }
        paid = seat.stack;
      } else {
        if (!legal.canRaise) return { ok: false, error: "Cannot raise." };
        if (raiseTo < legal.minRaiseTo)
          return { ok: false, error: "Raise below minimum." };
        const target = Math.min(raiseTo, legal.maxRaiseTo);
        paid = target - seat.betThisStreet;
      }
      if (paid <= 0) return { ok: false, error: "Invalid raise." };
      applyWagerIncrease(state, seat, paid);
      if (seat.status === "all_in") resolved = "all_in";
      break;
    }
    case "all_in": {
      if (!legal.canAllIn) return { ok: false, error: "All-in not allowed." };
      paid = seat.stack;
      if (paid <= 0) return { ok: false, error: "Nothing to shove." };
      const toCall = Math.max(0, state.currentBet - seat.betThisStreet);
      if (paid <= toCall) {
        // Call all-in (or partial) — does not reopen / change minRaise.
        seat.stack = 0;
        seat.betThisStreet += paid;
        seat.committedThisHand += paid;
        state.pot += paid;
        seat.status = "all_in";
        seat.actedAtBetLevel = state.currentBet;
      } else {
        // Increase — only reachable when raise rights are open (canAllIn gated).
        applyWagerIncrease(state, seat, paid);
      }
      resolved = "all_in";
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

function precheckAction(
  legal: LegalActions,
  seat: SeatState,
  state: GameState,
  action: ActionType,
  amount: number | undefined,
): { ok: true } | { ok: false; error: string } {
  void state;
  switch (action) {
    case "fold":
      return { ok: true };
    case "check":
      if (!legal.canCheck) return { ok: false, error: "Cannot check." };
      return { ok: true };
    case "call":
      if (!legal.canCall) return { ok: false, error: "Cannot call." };
      return { ok: true };
    case "bet": {
      if (!legal.canBet && !(legal.canAllIn && state.currentBet === 0)) {
        return { ok: false, error: "Cannot bet." };
      }
      if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
        return { ok: false, error: "Invalid bet amount." };
      }
      return { ok: true };
    }
    case "raise": {
      if (!legal.canRaise && !legal.canShortAllInRaise) {
        // Allow raise-to-all-in only when canAllIn with open increase rights.
        if (!(legal.canAllIn && raiseRightsOpen(state, seat) && seat.stack > 0)) {
          return { ok: false, error: "Cannot raise." };
        }
      }
      if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
        return { ok: false, error: "Invalid raise amount." };
      }
      if (
        amount !== undefined &&
        Number.isFinite(amount) &&
        amount < legal.minRaiseTo &&
        amount < seat.betThisStreet + seat.stack
      ) {
        return { ok: false, error: "Raise below minimum." };
      }
      return { ok: true };
    }
    case "all_in":
      if (!legal.canAllIn) return { ok: false, error: "All-in not allowed." };
      return { ok: true };
    default:
      return { ok: false, error: "Unknown action." };
  }
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
  seat.actedAtBetLevel = null;
  seat.timeBankMs = 0;
}

/**
 * Force-fold a player regardless of whose turn it is.
 * Commitments remain in the pot. Advances action if they were actionSeat.
 */
export function forceFoldPlayer(
  state: GameState,
  playerId: string,
  nowMs: number,
): { ok: true; events: EngineEvent[] } | { ok: false; error: string } {
  const seat = state.seats.find((s) => s.playerId === playerId);
  if (!seat) return { ok: false, error: "Player is not seated." };
  if (seat.status !== "active") {
    return { ok: true, events: [] };
  }

  const wasAction = state.actionSeat === seat.seatIndex;
  seat.status = "folded";
  seat.actedAtBetLevel = state.currentBet;
  state.sequence += 1;
  const events: EngineEvent[] = [
    {
      type: "action",
      playerId,
      action: "fold",
      amount: 0,
      pot: state.pot,
    },
  ];

  if (wasAction || state.actionSeat === seat.seatIndex) {
    return { ok: true, events: events.concat(advanceAfterAction(state, nowMs)) };
  }

  // Not their turn — check if hand ends (only one live hand left).
  const live = state.seats.filter((s) => liveInHand(s));
  if (live.length <= 1) {
    return { ok: true, events: events.concat(completeHand(state, nowMs)) };
  }
  const auto = maybeAutoRunout(state, nowMs);
  if (auto) return { ok: true, events: events.concat(auto) };
  return { ok: true, events };
}

/**
 * Remove a player from their seat. Mid-hand: force-fold if still active and defer
 * clearing the seat until the hand returns to waiting (preserves pot math).
 * All-in players stay live until hand completion.
 */
export function unseatPlayer(
  state: GameState,
  playerId: string,
  nowMs: number,
): { ok: true; events: EngineEvent[]; deferred: boolean } | { ok: false; error: string } {
  const seat = state.seats.find((s) => s.playerId === playerId);
  if (!seat) return { ok: false, error: "Player is not seated." };

  const events: EngineEvent[] = [];
  const inHand =
    state.street !== "waiting" &&
    (seat.status === "active" || seat.status === "all_in" || seat.status === "folded");

  if (inHand && seat.status === "active") {
    const fold = forceFoldPlayer(state, playerId, nowMs);
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

/**
 * Clear seats marked for deferred leave once the table is between hands.
 * Returns the final stacks that should be recorded for ledger buy-out
 * BEFORE seats are cleared (caller must record buy-outs).
 */
export function flushDeferredLeaves(
  state: GameState,
  playerIds: string[],
): Array<{ playerId: string; stack: number }> {
  if (state.street !== "waiting") return [];
  const settlements: Array<{ playerId: string; stack: number }> = [];
  for (const id of playerIds) {
    const seat = state.seats.find((s) => s.playerId === id);
    if (seat) {
      settlements.push({ playerId: id, stack: seat.stack });
      clearSeat(seat);
    }
  }
  if (playerIds.length) state.sequence += 1;
  return settlements;
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
  if (
    state.street !== "waiting" &&
    seat.status !== "sitting_out" &&
    seat.status !== "waiting_next_hand" &&
    seat.status !== "seated"
  ) {
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
    if (
      state.street !== "waiting" &&
      (seat.status === "active" || seat.status === "all_in")
    ) {
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
            ? (state.lastHandResult?.shownHands.find((h) => h.playerId === s.playerId)
                ?.cards ?? null)
            : null,
      isViewer: s.playerId === viewerId,
    })),
    legalActions:
      viewerId && state.actionSeat !== null && !state.paused
        ? (() => {
            const seat = state.seats[state.actionSeat!];
            if (seat?.playerId === viewerId)
              return getLegalActions(state, state.actionSeat!);
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
  state.pausedDuringTimeBank = false;
}

/**
 * Primary turn timer expired. Consume time bank before auto fold/check.
 * Returns { kind: 'bank' } if bank extended the turn, or { kind: 'timeout' } to auto-act.
 */
export function onTurnTimerExpired(
  state: GameState,
  nowMs: number,
): { kind: "bank"; events: EngineEvent[] } | { kind: "timeout" } | { kind: "noop" } {
  if (state.paused || state.actionSeat === null) return { kind: "noop" };
  const seat = state.seats[state.actionSeat];
  if (!seat || seat.status !== "active") return { kind: "noop" };

  // Already in bank phase — bank exhausted.
  if (state.timeBankStartedMs != null) {
    state.timeBankStartedMs = null;
    state.timeBankExtensionMs = null;
    state.pausedDuringTimeBank = false;
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
    if (state.timeBankStartedMs != null && state.timeBankExtensionMs != null) {
      // Freeze time-bank burn — wall-clock while paused must not consume bank.
      const used = Math.max(0, nowMs - state.timeBankStartedMs);
      const remaining = Math.max(0, state.timeBankExtensionMs - used);
      state.pausedTurnRemainingMs = remaining;
      state.timeBankExtensionMs = remaining;
      state.timeBankStartedMs = null;
      state.pausedDuringTimeBank = true;
      state.turnDeadlineMs = null;
    } else if (state.turnDeadlineMs != null) {
      state.pausedTurnRemainingMs = Math.max(0, state.turnDeadlineMs - nowMs);
      state.turnDeadlineMs = null;
      state.pausedDuringTimeBank = false;
    } else {
      state.pausedTurnRemainingMs = null;
      state.pausedDuringTimeBank = false;
    }
  } else {
    state.paused = false;
    if (state.pausedTurnRemainingMs != null && state.actionSeat !== null) {
      if (state.pausedDuringTimeBank) {
        state.timeBankStartedMs = nowMs;
        state.timeBankExtensionMs = state.pausedTurnRemainingMs;
        state.turnDeadlineMs = nowMs + state.pausedTurnRemainingMs;
      } else {
        state.turnDeadlineMs = nowMs + state.pausedTurnRemainingMs;
      }
      state.pausedTurnRemainingMs = null;
      state.pausedDuringTimeBank = false;
    } else {
      state.pausedTurnRemainingMs = null;
      state.pausedDuringTimeBank = false;
    }
  }
  state.sequence += 1;
  return { ok: true, events: [{ type: "paused", paused: state.paused }] };
}

/**
 * Reveal remaining undealt board cards after a hand ends (play-money fun only).
 * Simulates the same burn+deal sequence as normal dealing (deck.pop direction).
 * Never mutates the live board — only fills rabbitCards from a cloned deck walk.
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

  // Clone remaining deck and simulate burn+deal with pop (same as dealBoard).
  const deck = [...state.deck];
  const cards: Card[] = [];
  let boardLen = state.board.length;
  while (boardLen < 5) {
    const burn = deck.pop();
    if (!burn) {
      return { ok: false, error: "No undealt cards left." };
    }
    const count = boardLen === 0 ? 3 : 1;
    for (let i = 0; i < count; i++) {
      const c = deck.pop();
      if (!c) return { ok: false, error: "No undealt cards left." };
      cards.push(c);
      boardLen += 1;
    }
  }
  // Only the newly revealed cards (undealt streets).
  const rabbit = cards.slice(-need);
  state.rabbitCards = rabbit;
  state.sequence += 1;
  return { ok: true, events: [{ type: "rabbit", cards: rabbit }], cards: rabbit };
}

/** Total chips on the table (stacks + pot + street bets already in pot). */
export function totalChipsInPlay(state: GameState): number {
  let total = state.pot;
  for (const seat of state.seats) {
    if (seat.playerId) total += seat.stack;
  }
  return total;
}
