import { describe, expect, it } from "vitest";
import {
  BOARD_DEAL_STAGGER_MS,
  boardDealBatchMs,
  boardRevealDelayMs,
  holeDealBurstMs,
  holeDealStep,
  holeFlyerDelayMs,
  holeRevealDelayMs,
  HOLE_DEAL_STAGGER_MS,
} from "../../src/features/table/dealTiming";

describe("holeDealStep", () => {
  it("deals first cards around the table before second cards", () => {
    // 3 seats: A0, B0, C0, A1, B1, C1
    expect(holeDealStep(0, 0, 3)).toBe(0);
    expect(holeDealStep(1, 0, 3)).toBe(1);
    expect(holeDealStep(2, 0, 3)).toBe(2);
    expect(holeDealStep(0, 1, 3)).toBe(3);
    expect(holeDealStep(1, 1, 3)).toBe(4);
    expect(holeDealStep(2, 1, 3)).toBe(5);
  });
});

describe("hole timing", () => {
  it("staggers flyers by seat then by round", () => {
    expect(holeFlyerDelayMs(0, 0, 4)).toBe(0);
    expect(holeFlyerDelayMs(1, 0, 4)).toBe(HOLE_DEAL_STAGGER_MS);
    expect(holeFlyerDelayMs(0, 1, 4)).toBe(4 * HOLE_DEAL_STAGGER_MS);
  });

  it("reveals after the flyer has mostly landed", () => {
    expect(holeRevealDelayMs(0, 0, 2)).toBeGreaterThan(holeFlyerDelayMs(0, 0, 2));
  });

  it("keeps the burst long enough for the last card", () => {
    expect(holeDealBurstMs(3)).toBeGreaterThan(holeFlyerDelayMs(2, 1, 3));
  });
});

describe("board timing", () => {
  it("spaces flop cards one beat apart", () => {
    expect(boardRevealDelayMs(0)).toBe(0);
    expect(boardRevealDelayMs(1)).toBe(BOARD_DEAL_STAGGER_MS);
    expect(boardRevealDelayMs(2)).toBe(2 * BOARD_DEAL_STAGGER_MS);
  });

  it("covers the full flop batch", () => {
    expect(boardDealBatchMs(3)).toBeGreaterThan(boardRevealDelayMs(2));
  });
});
