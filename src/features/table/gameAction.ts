export type GameActionName = "fold" | "check" | "call" | "bet" | "raise" | "all_in";

export interface GameActionPayload {
  type: "action";
  action: GameActionName;
  expectedVersion: number;
  idempotencyKey: string;
  amount?: number;
}

/** Build a WS action message, or null when sequence is not yet known. */
export function buildGameAction(
  sequence: number | undefined | null,
  action: GameActionName,
  amount?: number,
): GameActionPayload | null {
  if (sequence == null || !Number.isInteger(sequence) || sequence < 0) return null;
  return {
    type: "action",
    action,
    ...(amount !== undefined ? { amount } : {}),
    expectedVersion: sequence,
    idempotencyKey: crypto.randomUUID(),
  };
}
