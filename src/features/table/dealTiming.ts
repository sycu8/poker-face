/**
 * Client-only deal choreography — slows hole cards and board reveals so each
 * card lands one-by-one (round-robin), closer to a live dealer cadence.
 */

/** Pause between successive flying hole cards. */
export const HOLE_DEAL_STAGGER_MS = 160;

/** Duration of one hole-card flyer animation (keep in sync with CSS). */
export const HOLE_DEAL_FLY_MS = 720;

/** How long after a flyer starts before the seat card fades in. */
export const HOLE_DEAL_LAND_MS = 480;

/** Pause between successive board cards (flop lands as three beats). */
export const BOARD_DEAL_STAGGER_MS = 280;

/** Duration of one board-card reveal animation (keep in sync with CSS). */
export const BOARD_DEAL_MS = 560;

/**
 * Poker-style deal index: first card to each seat in order, then second card.
 * `seatOrder` is clockwise-from-button; `cardIdx` is 0 or 1.
 */
export function holeDealStep(
  seatOrder: number,
  cardIdx: number,
  seatCount: number,
): number {
  const n = Math.max(seatCount, 1);
  return cardIdx * n + seatOrder;
}

/** Animation delay (ms) before a hole flyer starts. */
export function holeFlyerDelayMs(
  seatOrder: number,
  cardIdx: number,
  seatCount: number,
): number {
  return holeDealStep(seatOrder, cardIdx, seatCount) * HOLE_DEAL_STAGGER_MS;
}

/** When a seat's hole card should fade in after flying. */
export function holeRevealDelayMs(
  seatOrder: number,
  cardIdx: number,
  seatCount: number,
): number {
  return holeFlyerDelayMs(seatOrder, cardIdx, seatCount) + HOLE_DEAL_LAND_MS;
}

/** Total time to keep the deal burst layer mounted. */
export function holeDealBurstMs(seatCount: number): number {
  const n = Math.max(seatCount, 1);
  const lastStep = holeDealStep(n - 1, 1, n);
  return lastStep * HOLE_DEAL_STAGGER_MS + HOLE_DEAL_FLY_MS + 120;
}

/** Delay for a newly dealt board card within its street batch. */
export function boardRevealDelayMs(indexInBatch: number): number {
  return Math.max(0, indexInBatch) * BOARD_DEAL_STAGGER_MS;
}

/** How long a board reveal batch should stay "dealing". */
export function boardDealBatchMs(newCardCount: number): number {
  const n = Math.max(newCardCount, 1);
  return (n - 1) * BOARD_DEAL_STAGGER_MS + BOARD_DEAL_MS + 80;
}
