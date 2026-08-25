import { describe, expect, it } from "vitest";
import { buildDeck, shuffleDeck } from "../../worker/domain/cards";
import { compareHands, evaluateBestHand } from "../../worker/domain/handRank";
import { computeSidePots } from "../../worker/domain/pots";
import {
  applyAction,
  createInitialGameState,
  projectForPlayer,
  seatPlayer,
  startHand,
} from "../../worker/domain/engine";
import { validateConfigInput } from "../../worker/domain/config";

describe("cards", () => {
  it("builds a 52-card deck", () => {
    const deck = buildDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
  });

  it("shuffles without losing cards", () => {
    const deck = buildDeck();
    const shuffled = shuffleDeck(deck);
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled).size).toBe(52);
  });
});

describe("hand evaluation", () => {
  it("ranks royal flush above four of a kind", () => {
    const rf = evaluateBestHand(["Ah", "Kh", "Qh", "Jh", "Th"]);
    const quads = evaluateBestHand(["9c", "9d", "9h", "9s", "2c"]);
    expect(compareHands(rf, quads)).toBeGreaterThan(0);
    expect(rf.category).toBe("straight_flush");
  });

  it("detects wheel straight", () => {
    const wheel = evaluateBestHand(["Ac", "2d", "3h", "4s", "5c"]);
    expect(wheel.category).toBe("straight");
  });

  it("picks best five from seven", () => {
    const hand = evaluateBestHand(["Ah", "Ad", "2c", "3d", "4h", "9s", "Ac"]);
    expect(hand.category).toBe("three_of_a_kind");
  });
});

describe("side pots", () => {
  it("builds layered pots", () => {
    const contributions = new Map([
      ["a", 50],
      ["b", 100],
      ["c", 100],
    ]);
    const pots = computeSidePots(contributions, ["a", "b", "c"]);
    expect(pots[0]?.amount).toBe(150);
    expect(pots[0]?.eligiblePlayerIds.sort()).toEqual(["a", "b", "c"]);
    expect(pots[1]?.amount).toBe(100);
    expect(pots[1]?.eligiblePlayerIds.sort()).toEqual(["b", "c"]);
  });
});

describe("config", () => {
  it("forces big blind = 2 * small blind", () => {
    const res = validateConfigInput({ smallBlind: 5, startingStack: 200 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.bigBlind).toBe(10);
    }
  });

  it("rejects stacks outside 10–1000", () => {
    expect(validateConfigInput({ smallBlind: 1, startingStack: 5 }).ok).toBe(false);
    expect(validateConfigInput({ smallBlind: 1, startingStack: 1001 }).ok).toBe(false);
  });
});

describe("engine privacy and flow", () => {
  it("never leaks opponent hole cards in projection", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) return;
    const state = createInitialGameState(cfg.config);
    expect(seatPlayer(state, "p1", "Ada", 0).ok).toBe(true);
    expect(seatPlayer(state, "p2", "Bea", 1).ok).toBe(true);
    startHand(state, Date.now());
    const view = projectForPlayer(state, "p1");
    const self = view.seats.find((s) => s.playerId === "p1");
    const opp = view.seats.find((s) => s.playerId === "p2");
    expect(self?.holeCards).toHaveLength(2);
    expect(opp?.holeCards).toBeNull();
  });

  it("completes a heads-up fold", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    if (!cfg.ok) throw new Error("bad config");
    const state = createInitialGameState(cfg.config);
    seatPlayer(state, "p1", "Ada", 0);
    seatPlayer(state, "p2", "Bea", 1);
    startHand(state, 1_000_000);
    expect(state.actionSeat).not.toBeNull();
    const actor = state.actionSeat!;
    const res = applyAction(state, actor, "fold", undefined, 1_000_100, "idem-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.events.some((e) => e.type === "hand_complete")).toBe(true);
    }
  });
});
