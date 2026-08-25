import { describe, expect, it } from "vitest";
import { seatRingStyle, visualSeatIndex } from "../../src/features/table/seatLayout";

describe("visualSeatIndex", () => {
  it("anchors the viewer seat at visual 0 (bottom)", () => {
    expect(visualSeatIndex(3, 9, 3)).toBe(0);
    expect(visualSeatIndex(4, 9, 3)).toBe(1);
    expect(visualSeatIndex(2, 9, 3)).toBe(8);
  });

  it("defaults host seat 0 to bottom when no viewer offset", () => {
    expect(visualSeatIndex(0, 6, 0)).toBe(0);
    expect(visualSeatIndex(1, 6, 0)).toBe(1);
    expect(visualSeatIndex(5, 6, 0)).toBe(5);
  });
});

describe("seatRingStyle", () => {
  it("places visual 0 at the bottom center of the oval", () => {
    const style = seatRingStyle(0, 9);
    expect(style.left).toBe("50%");
    expect(Number.parseFloat(String(style.top))).toBeGreaterThan(85);
  });

  it("spreads seats around the ring", () => {
    const tops = [0, 1, 2, 3, 4].map((i) => seatRingStyle(i, 5).top);
    expect(new Set(tops).size).toBeGreaterThan(1);
  });
});
