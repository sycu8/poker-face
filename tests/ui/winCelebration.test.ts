import { describe, expect, it } from "vitest";
import {
  summarizePots,
  winningBestFiveCodes,
  winningPlayerIds,
  type WinCelebrationWinner,
} from "../../src/features/table/WinCelebration";

const contested: WinCelebrationWinner = {
  playerId: "p1",
  amount: 120,
  potIndex: 0,
  hand: {
    category: "three_of_a_kind",
    label: "Three of a kind",
    bestFive: ["Ah", "Ad", "As", "Kc", "9d"],
    strength: [3, 14, 13, 9],
  },
};

const foldWin: WinCelebrationWinner = {
  playerId: "p2",
  amount: 40,
  potIndex: 0,
};

describe("summarizePots", () => {
  it("keeps contested bestFive for the primary pot", () => {
    const pots = summarizePots([contested], (id) => (id === "p1" ? "Alice" : id));
    expect(pots).toHaveLength(1);
    expect(pots[0]!.label).toBe("Three of a kind");
    expect(pots[0]!.bestFive).toEqual(["Ah", "Ad", "As", "Kc", "9d"]);
    expect(pots[0]!.names).toEqual(["Alice"]);
  });

  it("omits bestFive for uncontested fold wins", () => {
    const pots = summarizePots([foldWin], () => "Bob");
    expect(pots[0]!.bestFive).toBeNull();
    expect(pots[0]!.label).toBeNull();
  });

  it("surfaces each pot's cards when side pots differ", () => {
    const side: WinCelebrationWinner = {
      playerId: "p3",
      amount: 60,
      potIndex: 1,
      hand: {
        category: "pair",
        label: "Pair",
        bestFive: ["Kh", "Kd", "7c", "4s", "2h"],
        strength: [1, 13, 7, 4, 2],
      },
    };
    const pots = summarizePots([contested, side], (id) => id);
    expect(pots).toHaveLength(2);
    expect(pots[0]!.bestFive).toHaveLength(5);
    expect(pots[1]!.bestFive).toEqual(["Kh", "Kd", "7c", "4s", "2h"]);
    expect(pots[1]!.label).toBe("Pair");
  });
});

describe("winningBestFiveCodes", () => {
  it("collects unique codes from contested winners only", () => {
    const codes = winningBestFiveCodes([contested, foldWin]);
    expect(codes.has("Ah")).toBe(true);
    expect(codes.has("9d")).toBe(true);
    expect(codes.size).toBe(5);
  });
});

describe("winningPlayerIds", () => {
  it("returns every winner id", () => {
    expect([...winningPlayerIds([contested, foldWin])].sort()).toEqual(["p1", "p2"]);
  });
});
