export const MIN_STACK = 10;
export const MAX_STACK = 1000;
export const DEFAULT_POT_CAP_MULTIPLIER = 2;
export const DEFAULT_TURN_MS = 30_000;
/** Poker Now–style max ring size (Hold'em). */
export const MAX_SEATS = 10;
export const MIN_SEATS_TO_DEAL = 2;
/** Default time-bank pool per seated player (seconds). */
export const DEFAULT_TIME_BANK_SECONDS = 60;

export type Street = "waiting" | "preflop" | "flop" | "turn" | "river" | "showdown";

export type PlayerStatus =
  | "empty"
  | "seated"
  | "waiting_next_hand"
  | "active"
  | "folded"
  | "all_in"
  | "sitting_out";

export interface TableConfig {
  smallBlind: number;
  bigBlind: number;
  startingStack: number;
  potCapMultiplier: number;
  turnTimeoutMs: number;
  maxSeats: number;
  /** Per-player time-bank pool in seconds (host-configurable). */
  timeBankSeconds: number;
}

export interface PendingConfig {
  smallBlind?: number;
  startingStack?: number;
  potCapMultiplier?: number;
  turnTimeoutMs?: number;
  timeBankSeconds?: number;
}

export function validateConfigInput(input: {
  smallBlind: number;
  startingStack: number;
  potCapMultiplier?: number;
  timeBankSeconds?: number;
}): { ok: true; config: TableConfig } | { ok: false; error: string } {
  if (!Number.isInteger(input.smallBlind) || input.smallBlind < 1) {
    return { ok: false, error: "Small blind must be a positive integer." };
  }
  if (
    !Number.isInteger(input.startingStack) ||
    input.startingStack < MIN_STACK ||
    input.startingStack > MAX_STACK
  ) {
    return {
      ok: false,
      error: `Starting stacks must be between ${MIN_STACK} and ${MAX_STACK} virtual chips.`,
    };
  }
  const potCapMultiplier = input.potCapMultiplier ?? DEFAULT_POT_CAP_MULTIPLIER;
  if (!Number.isFinite(potCapMultiplier) || potCapMultiplier < 1) {
    return { ok: false, error: "Pot-cap multiplier must be at least 1." };
  }
  const timeBankSeconds = input.timeBankSeconds ?? DEFAULT_TIME_BANK_SECONDS;
  if (
    !Number.isInteger(timeBankSeconds) ||
    timeBankSeconds < 0 ||
    timeBankSeconds > 600
  ) {
    return { ok: false, error: "Time bank must be between 0 and 600 seconds." };
  }
  return {
    ok: true,
    config: {
      smallBlind: input.smallBlind,
      bigBlind: input.smallBlind * 2,
      startingStack: input.startingStack,
      potCapMultiplier,
      turnTimeoutMs: DEFAULT_TURN_MS,
      maxSeats: MAX_SEATS,
      timeBankSeconds,
    },
  };
}

export function promoteConfig(current: TableConfig, pending: PendingConfig | null): TableConfig {
  if (!pending) return current;
  const smallBlind = pending.smallBlind ?? current.smallBlind;
  const startingStack = pending.startingStack ?? current.startingStack;
  const potCapMultiplier = pending.potCapMultiplier ?? current.potCapMultiplier;
  const turnTimeoutMs = pending.turnTimeoutMs ?? current.turnTimeoutMs;
  const timeBankSeconds = pending.timeBankSeconds ?? current.timeBankSeconds;
  return {
    ...current,
    smallBlind,
    bigBlind: smallBlind * 2,
    startingStack,
    potCapMultiplier,
    turnTimeoutMs,
    timeBankSeconds,
  };
}

/** Max target wager for a non-all-in action based on pot before the action. */
export function maxTargetWager(potBeforeAction: number, potCapMultiplier: number): number {
  return Math.floor(Math.max(0, potBeforeAction) * potCapMultiplier);
}
