import { describe, expect, it } from "vitest";
import { dealOrderSeatIndexes, seatRingPercents, visualSeatIndex } from "../../src/features/table/seatLayout";

describe("seatLayout deal helpers", () => {
  it("places visual 0 at bottom of the ellipse", () => {
    const p = seatRingPercents(0, 6);
    expect(p.left).toBeCloseTo(50, 5);
    expect(p.top).toBeGreaterThan(80);
  });

  it("orders deals clockwise from after the dealer", () => {
    expect(dealOrderSeatIndexes(0, [0, 2, 4], 6)).toEqual([2, 4, 0]);
    expect(dealOrderSeatIndexes(3, [1, 3, 5], 6)).toEqual([5, 1, 3]);
  });

  it("maps anchor to visual 0", () => {
    expect(visualSeatIndex(3, 6, 3)).toBe(0);
    expect(visualSeatIndex(4, 6, 3)).toBe(1);
  });
});
