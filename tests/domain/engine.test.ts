import { describe, expect, it } from "vitest";
import { buildDeck, shuffleDeck } from "../../worker/domain/cards";
import {
  categoryDisplayLabel,
  compareHands,
  evaluateBestHand,
  isRoyalFlush,
} from "../../worker/domain/handRank";
import { computeSidePots } from "../../worker/domain/pots";
import {
  applyAction,
  createInitialGameState,
  getLegalActions,
  projectForPlayer,
  rebuyPlayer,
  seatPlayer,
  setPaused,
  setPlayerAway,
  startHand,
  unseatPlayer,
  onTurnTimerExpired,
  rabbitHunt,
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
    expect(isRoyalFlush(rf)).toBe(true);
    expect(categoryDisplayLabel(rf)).toBe("Royal flush");
  });

  it("labels straight flush below royal", () => {
    const sf = evaluateBestHand(["9h", "8h", "7h", "6h", "5h"]);
    expect(sf.category).toBe("straight_flush");
    expect(isRoyalFlush(sf)).toBe(false);
    expect(categoryDisplayLabel(sf)).toBe("Straight flush");
  });

  it("uses user-facing category names for common ranks", () => {
    expect(categoryDisplayLabel(evaluateBestHand(["Ah", "Ad", "Ac", "As", "2c"]))).toBe(
      "Four of a kind",
    );
    expect(categoryDisplayLabel(evaluateBestHand(["Ah", "Ad", "Ac", "2s", "2c"]))).toBe(
      "Full house",
    );
    expect(categoryDisplayLabel(evaluateBestHand(["Ah", "Kh", "9h", "4h", "2h"]))).toBe("Flush");
    expect(categoryDisplayLabel(evaluateBestHand(["9c", "8d", "7h", "6s", "5c"]))).toBe("Straight");
    expect(categoryDisplayLabel(evaluateBestHand(["Ah", "Ad", "Ac", "9s", "2c"]))).toBe(
      "Three of a kind",
    );
    expect(categoryDisplayLabel(evaluateBestHand(["Ah", "Ad", "Kc", "Ks", "2c"]))).toBe("Two pair");
    expect(categoryDisplayLabel(evaluateBestHand(["Ah", "Ad", "9c", "5s", "2c"]))).toBe("One pair");
    expect(categoryDisplayLabel(evaluateBestHand(["Ah", "Kd", "9c", "5s", "2c"]))).toBe("High card");
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
    // Uncontested pot — no evaluated hand category
    expect(state.lastHandResult?.winners.every((w) => w.hand === undefined)).toBe(true);
  });

  it("ignores deal while a hand is already in progress", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    if (!cfg.ok) throw new Error("bad config");
    const state = createInitialGameState(cfg.config);
    seatPlayer(state, "p1", "Ada", 0);
    seatPlayer(state, "p2", "Bea", 1);
    startHand(state, 1_000_000);
    expect(state.street).toBe("preflop");
    const handNumber = state.handNumber;
    const sequence = state.sequence;
    const board = [...state.board];
    const events = startHand(state, 1_000_500);
    expect(events).toHaveLength(0);
    expect(state.street).toBe("preflop");
    expect(state.handNumber).toBe(handNumber);
    expect(state.sequence).toBe(sequence);
    expect(state.board).toEqual(board);
  });

  it("includes winning hand category on showdown HandResult", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    if (!cfg.ok) throw new Error("bad config");
    const state = createInitialGameState(cfg.config);
    seatPlayer(state, "p1", "Ada", 0);
    seatPlayer(state, "p2", "Bea", 1);
    startHand(state, 2_000_000);

    // Force a known river showdown: Ada has trip aces, Bea has high card.
    for (const seat of state.seats) {
      if (!seat.playerId) continue;
      seat.status = "active";
      seat.betThisStreet = 0;
      seat.hasActedThisStreet = false;
      seat.committedThisHand = Math.max(seat.committedThisHand, 2);
    }
    state.seats[0]!.holeCards = ["Ah", "Ad"];
    state.seats[1]!.holeCards = ["Kc", "Qd"];
    state.board = ["As", "2c", "3d", "4h", "7s"];
    state.street = "river";
    state.currentBet = 0;
    state.minRaise = state.config.bigBlind;
    state.pot = Math.max(state.pot, 4);
    state.actionSeat = 0;
    state.turnDeadlineMs = 2_000_000 + 30_000;

    const check0 = applyAction(state, 0, "check", undefined, 2_000_100, "sd-check-0");
    expect(check0.ok).toBe(true);
    expect(state.actionSeat).toBe(1);
    const check1 = applyAction(state, 1, "check", undefined, 2_000_200, "sd-check-1");
    expect(check1.ok).toBe(true);

    expect(state.lastHandResult).not.toBeNull();
    const winners = state.lastHandResult!.winners;
    expect(winners.length).toBeGreaterThan(0);
    expect(winners.every((w) => w.hand !== undefined)).toBe(true);
    expect(winners[0]!.hand!.category).toBe("three_of_a_kind");
    expect(winners[0]!.hand!.label).toBe("Three of a kind");
    expect(winners[0]!.hand!.bestFive).toHaveLength(5);
    expect(winners[0]!.playerId).toBe("p1");

    const view = projectForPlayer(state, "p1");
    expect(view.lastHandResult?.winners[0]?.hand?.label).toBe("Three of a kind");
  });
});

describe("leave / rebuy / away", () => {
  it("unseats a waiting player immediately", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    if (!cfg.ok) throw new Error(cfg.error);
    const state = createInitialGameState(cfg.config);
    expect(seatPlayer(state, "a", "A", 0).ok).toBe(true);
    expect(seatPlayer(state, "b", "B", 1).ok).toBe(true);
    const left = unseatPlayer(state, "b", Date.now());
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    expect(left.deferred).toBe(false);
    expect(state.seats[1]!.playerId).toBeNull();
  });

  it("defers mid-hand leave until waiting and preserves commitments", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    if (!cfg.ok) throw new Error(cfg.error);
    const state = createInitialGameState(cfg.config);
    seatPlayer(state, "a", "A", 0);
    seatPlayer(state, "b", "B", 1);
    startHand(state, 1_000);
    const actor = state.actionSeat!;
    const other = state.seats.find((s) => s.playerId && s.seatIndex !== actor)!;
    const committed = other.committedThisHand;
    const leave = unseatPlayer(state, other.playerId!, 2_000);
    expect(leave.ok).toBe(true);
    if (!leave.ok) return;
    if (state.street !== "waiting") {
      expect(leave.deferred).toBe(true);
      expect(state.seats.find((s) => s.playerId === other.playerId)?.committedThisHand).toBe(
        committed,
      );
    }
  });

  it("rebuy resets a busted seat", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    if (!cfg.ok) throw new Error(cfg.error);
    const state = createInitialGameState(cfg.config);
    seatPlayer(state, "a", "A", 0);
    state.seats[0]!.stack = 0;
    state.seats[0]!.status = "sitting_out";
    expect(rebuyPlayer(state, "a").ok).toBe(true);
    expect(state.seats[0]!.stack).toBe(100);
    expect(state.seats[0]!.status).toBe("seated");
  });

  it("away toggles sitting_out between hands", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    if (!cfg.ok) throw new Error(cfg.error);
    const state = createInitialGameState(cfg.config);
    seatPlayer(state, "a", "A", 0);
    expect(setPlayerAway(state, "a", true).ok).toBe(true);
    expect(state.seats[0]!.status).toBe("sitting_out");
    expect(setPlayerAway(state, "a", false).ok).toBe(true);
    expect(state.seats[0]!.status).toBe("seated");
  });
});

describe("e2e smoke: seat → deal → hand", () => {
  it("runs one hand after two players seat", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    if (!cfg.ok) throw new Error(cfg.error);
    const state = createInitialGameState(cfg.config);
    expect(seatPlayer(state, "host", "Host", 0).ok).toBe(true);
    expect(seatPlayer(state, "guest", "Guest", 2).ok).toBe(true); // seat picker seat 2
    const started = startHand(state, Date.now());
    expect(started.some((e) => e.type === "hand_started")).toBe(true);
    expect(state.street).toBe("preflop");
    expect(state.seats[0]!.holeCards).toHaveLength(2);
    expect(state.seats[2]!.holeCards).toHaveLength(2);

    // Fold / check until hand completes or a few actions.
    let guard = 0;
    while (state.street !== "waiting" && guard++ < 40) {
      const seatIdx = state.actionSeat;
      if (seatIdx == null) break;
      const legal = getLegalActions(state, seatIdx);
      if (!legal) break;
      const action = legal.canCheck ? "check" : legal.canCall ? "call" : "fold";
      const res = applyAction(state, seatIdx, action, undefined, Date.now() + guard, `smoke:${guard}`);
      expect(res.ok).toBe(true);
    }
    expect(state.handNumber).toBeGreaterThanOrEqual(1);
    const hostView = projectForPlayer(state, "host");
    const guestHole = hostView.seats.find((s) => s.playerId === "guest")?.holeCards;
    // Privacy: foreign hole cards must not leak to host between hands / mid-hand when not shown.
    if (state.street !== "waiting" && state.street !== "showdown") {
      expect(guestHole).toBeNull();
    }
  });
});

describe("pokernow parity engine", () => {
  it("defaults to 10 max seats and time bank", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) return;
    expect(cfg.config.maxSeats).toBe(10);
    expect(cfg.config.timeBankSeconds).toBe(60);
    const state = createInitialGameState(cfg.config);
    expect(state.seats).toHaveLength(10);
    seatPlayer(state, "a", "A", 0);
    expect(state.seats[0]!.timeBankMs).toBe(60_000);
  });

  it("blocks deal while paused and freezes turn timer", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    if (!cfg.ok) throw new Error(cfg.error);
    const state = createInitialGameState(cfg.config);
    seatPlayer(state, "a", "A", 0);
    seatPlayer(state, "b", "B", 1);
    expect(setPaused(state, true, 1_000).ok).toBe(true);
    expect(startHand(state, 1_100)).toHaveLength(0);
    expect(setPaused(state, false, 1_200).ok).toBe(true);
    startHand(state, 1_300);
    expect(state.street).toBe("preflop");
    const before = state.turnDeadlineMs;
    expect(setPaused(state, true, 1_400).ok).toBe(true);
    expect(state.paused).toBe(true);
    expect(state.turnDeadlineMs).toBeNull();
    expect(state.pausedTurnRemainingMs).toBe(before! - 1_400);
    expect(applyAction(state, state.actionSeat!, "fold", undefined, 1_500, "p").ok).toBe(false);
  });

  it("consumes time bank before timeout fold/check", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100, timeBankSeconds: 30 });
    if (!cfg.ok) throw new Error(cfg.error);
    const state = createInitialGameState(cfg.config);
    seatPlayer(state, "a", "A", 0);
    seatPlayer(state, "b", "B", 1);
    startHand(state, 1_000);
    const seat = state.seats[state.actionSeat!]!;
    expect(seat.timeBankMs).toBe(30_000);
    const bank = onTurnTimerExpired(state, 2_000);
    expect(bank.kind).toBe("bank");
    expect(state.timeBankStartedMs).toBe(2_000);
    expect(seat.timeBankMs).toBe(0);
    const timeout = onTurnTimerExpired(state, 40_000);
    expect(timeout.kind).toBe("timeout");
  });

  it("rabbit hunts remaining undealt board cards between hands", () => {
    const cfg = validateConfigInput({ smallBlind: 1, startingStack: 100 });
    if (!cfg.ok) throw new Error(cfg.error);
    const state = createInitialGameState(cfg.config);
    seatPlayer(state, "a", "A", 0);
    seatPlayer(state, "b", "B", 1);
    startHand(state, 1_000);
    const actor = state.actionSeat!;
    applyAction(state, actor, "fold", undefined, 1_100, "f1");
    expect(state.street).toBe("waiting");
    expect(state.board.length).toBeLessThan(5);
    const need = 5 - state.board.length;
    const rabbit = rabbitHunt(state);
    expect(rabbit.ok).toBe(true);
    if (!rabbit.ok) return;
    expect(rabbit.cards).toHaveLength(need);
    expect(state.rabbitCards).toHaveLength(need);
    const view = projectForPlayer(state, "spectator-user");
    expect(view.isSpectator).toBe(true);
    expect(view.rabbitCards).toHaveLength(need);
  });
});
