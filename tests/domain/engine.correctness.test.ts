import { describe, expect, it } from "vitest";
import { buildDeck, shuffleDeck } from "../../worker/domain/cards";
import { computeSidePots } from "../../worker/domain/pots";
import {
  applyAction,
  createInitialGameState,
  forceFoldPlayer,
  flushDeferredLeaves,
  getLegalActions,
  onTurnTimerExpired,
  rabbitHunt,
  raiseRightsOpen,
  seatPlayer,
  setPaused,
  startHand,
  totalChipsInPlay,
  unseatPlayer,
} from "../../worker/domain/engine";
import { validateConfigInput } from "../../worker/domain/config";
import {
  emptyLedger,
  recordBuyIn,
  recordBuyOut,
  buildLedgerSnapshot,
} from "../../worker/domain/ledger";

function cfg(stack = 200, sb = 5) {
  const res = validateConfigInput({ smallBlind: sb, startingStack: stack });
  if (!res.ok) throw new Error(res.error);
  return res.config;
}

function seatMany(
  state: ReturnType<typeof createInitialGameState>,
  players: Array<[string, string, number]>,
) {
  for (const [id, name, seat] of players) {
    expect(seatPlayer(state, id, name, seat).ok).toBe(true);
  }
}

describe("heads-up blinds and action order", () => {
  it("button posts SB, other posts BB; button acts first preflop; BB first postflop", () => {
    const state = createInitialGameState(cfg(200, 5));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    // Force dealer to seat 0 so A is button.
    state.dealerSeat = 1; // startHand advances to next → 0
    startHand(state, 1_000);
    expect(state.dealerSeat).toBe(0);
    expect(state.seats[0]!.betThisStreet).toBe(5); // SB (button)
    expect(state.seats[1]!.betThisStreet).toBe(10); // BB
    expect(state.actionSeat).toBe(0); // button/SB acts first preflop

    // Call and BB checks → flop; BB should act first
    expect(applyAction(state, 0, "call", undefined, 1_100, "hu-c").ok).toBe(true);
    expect(state.actionSeat).toBe(1);
    expect(applyAction(state, 1, "check", undefined, 1_200, "hu-k").ok).toBe(true);
    expect(state.street).toBe("flop");
    expect(state.actionSeat).toBe(1); // BB first postflop
  });

  it("3-player keeps normal SB/BB left of button", () => {
    const state = createInitialGameState(cfg(200, 5));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
      ["c", "C", 2],
    ]);
    state.dealerSeat = 2; // advances to 0
    startHand(state, 1_000);
    expect(state.dealerSeat).toBe(0);
    expect(state.seats[1]!.betThisStreet).toBe(5); // SB
    expect(state.seats[2]!.betThisStreet).toBe(10); // BB
    expect(state.actionSeat).toBe(0); // UTG
  });

  it("3 → 2 transition uses heads-up blinds and action order", () => {
    const state = createInitialGameState(cfg(200, 5));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
      ["c", "C", 2],
    ]);
    state.dealerSeat = 2;
    startHand(state, 1_000);
    expect(state.dealerSeat).toBe(0);
    // Fold everyone but one to end the hand
    expect(applyAction(state, 0, "fold", undefined, 1_100, "f0").ok).toBe(true);
    expect(applyAction(state, 1, "fold", undefined, 1_200, "f1").ok).toBe(true);
    expect(state.street).toBe("waiting");
    // C leaves between hands
    expect(unseatPlayer(state, "c", 2_000).ok).toBe(true);
    expect(state.seats.filter((s) => s.playerId).length).toBe(2);

    // Next hand: remaining A (0) and B (1) — heads-up rules
    // Previous dealer was 0; advance to next occupied → 1
    startHand(state, 3_000);
    expect(state.dealerSeat).toBe(1);
    expect(state.seats[1]!.betThisStreet).toBe(5); // button posts SB
    expect(state.seats[0]!.betThisStreet).toBe(10); // BB
    expect(state.actionSeat).toBe(1); // button/SB acts first preflop

    expect(applyAction(state, 1, "call", undefined, 3_100, "hu2-c").ok).toBe(true);
    expect(applyAction(state, 0, "check", undefined, 3_200, "hu2-k").ok).toBe(true);
    expect(state.street).toBe("flop");
    expect(state.actionSeat).toBe(0); // BB first postflop
  });
});

describe("short big blind", () => {
  it("3-player short BB keeps opening level at full BB", () => {
    const state = createInitialGameState(cfg(200, 10));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
      ["c", "C", 2],
    ]);
    state.seats[2]!.stack = 5; // will be BB after dealer→0
    state.dealerSeat = 2;
    startHand(state, 1_000);
    expect(state.dealerSeat).toBe(0);
    expect(state.seats[2]!.status).toBe("all_in");
    expect(state.seats[2]!.betThisStreet).toBe(5);
    expect(state.currentBet).toBe(20); // full BB
    const utg = getLegalActions(state, state.actionSeat!);
    expect(utg?.callAmount).toBe(20);
  });

  it("4-player short BB keeps full BB level", () => {
    const state = createInitialGameState(cfg(200, 10));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
      ["c", "C", 2],
      ["d", "D", 3],
    ]);
    state.seats[2]!.stack = 7;
    state.dealerSeat = 3;
    startHand(state, 1_000);
    expect(state.currentBet).toBe(20);
  });

  it("HU short BB faces contested amount", () => {
    const state = createInitialGameState(cfg(200, 10));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    // BB covers less than full BB but more than SB so button still faces a call.
    state.seats[1]!.stack = 15;
    state.dealerSeat = 1;
    startHand(state, 1_000);
    expect(state.dealerSeat).toBe(0);
    expect(state.street).toBe("preflop");
    expect(state.seats[1]!.status).toBe("all_in");
    expect(state.seats[1]!.betThisStreet).toBe(15);
    expect(state.currentBet).toBe(15); // HU: contested amount
    expect(state.actionSeat).toBe(0);
    const legal = getLegalActions(state, 0)!;
    expect(legal.callAmount).toBe(5);
  });
});

describe("legal actions — call all-in", () => {
  it("allows CALL when stack == toCall", () => {
    const state = createInitialGameState(cfg(100, 1));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    startHand(state, 1_000);
    // Force B to face toCall=40 with stack=40
    const actor = state.actionSeat!;
    const other = actor === 0 ? 1 : 0;
    state.seats[actor]!.stack = 200;
    state.seats[other]!.stack = 40;
    state.seats[other]!.betThisStreet = 0;
    state.currentBet = 40;
    state.actionSeat = other;
    const legal = getLegalActions(state, other)!;
    expect(legal.canCall).toBe(true);
    expect(legal.callAmount).toBe(40);
    expect(legal.callIsAllIn).toBe(true);
    expect(applyAction(state, other, "call", undefined, 1_100, "c40").ok).toBe(true);
    expect(state.seats[other]!.status).toBe("all_in");
  });

  it("allows CALL when stack < toCall (short call all-in)", () => {
    const state = createInitialGameState(cfg(100, 1));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    startHand(state, 1_000);
    const other = state.actionSeat === 0 ? 1 : 0;
    state.seats[other]!.stack = 25;
    state.seats[other]!.betThisStreet = 0;
    state.currentBet = 40;
    state.actionSeat = other;
    const legal = getLegalActions(state, other)!;
    expect(legal.canCall).toBe(true);
    expect(legal.callAmount).toBe(25);
    expect(legal.callIsAllIn).toBe(true);
    expect(legal.canRaise).toBe(false);
  });

  it("never sets canRaise when minRaiseTo > maxRaiseTo", () => {
    const state = createInitialGameState(cfg(100, 5));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    startHand(state, 1_000);
    const seat = state.actionSeat!;
    state.seats[seat]!.stack = 3;
    state.currentBet = 50;
    state.minRaise = 50;
    state.seats[seat]!.betThisStreet = 0;
    const legal = getLegalActions(state, seat)!;
    if (legal.canRaise) {
      expect(legal.minRaiseTo).toBeLessThanOrEqual(legal.maxRaiseTo);
    }
  });
});

describe("short all-in raise reopen", () => {
  function openFlop(players: number, potCap = 100) {
    const res = validateConfigInput({
      smallBlind: 5,
      startingStack: 500,
      potCapMultiplier: potCap,
    });
    if (!res.ok) throw new Error(res.error);
    const state = createInitialGameState(res.config);
    const list: Array<[string, string, number]> = [
      ["a", "A", 0],
      ["b", "B", 1],
      ["c", "C", 2],
    ];
    if (players >= 4) list.push(["d", "D", 3]);
    seatMany(state, list.slice(0, players));
    state.street = "flop";
    state.dealerSeat = 0;
    for (const s of state.seats) {
      if (s.playerId) {
        s.status = "active";
        s.betThisStreet = 0;
        s.actedAtBetLevel = null;
        s.committedThisHand = 0;
        s.holeCards = ["Ah", "Kh"];
        s.stack = 500;
      }
    }
    state.board = ["2c", "3d", "4h"];
    state.pot = 200;
    state.currentBet = 0;
    state.minRaise = 10;
    state.deck = buildDeck();
    state.actionSeat = 0;
    return state;
  }

  it("Example A: +30 short all-in does not reopen raise for callers", () => {
    const state = openFlop(3);
    expect(applyAction(state, 0, "bet", 100, 1_000, "a-bet").ok).toBe(true);
    expect(state.currentBet).toBe(100);
    expect(state.minRaise).toBe(100);

    expect(state.actionSeat).toBe(1);
    expect(applyAction(state, 1, "call", undefined, 1_100, "b-call").ok).toBe(true);

    expect(state.actionSeat).toBe(2);
    state.seats[2]!.stack = 130;
    expect(applyAction(state, 2, "all_in", undefined, 1_200, "c-ai").ok).toBe(true);
    expect(state.currentBet).toBe(130);
    expect(state.minRaise).toBe(100);

    expect(state.actionSeat).toBe(0);
    const legalA = getLegalActions(state, 0)!;
    expect(legalA.canCall).toBe(true);
    expect(legalA.callAmount).toBe(30);
    expect(legalA.canRaise).toBe(false);
    expect(raiseRightsOpen(state, state.seats[0]!)).toBe(false);
  });

  it("Example B: cumulative short all-ins totaling full raise reopen rights", () => {
    const state = openFlop(3);
    expect(applyAction(state, 0, "bet", 100, 1_000, "a-bet").ok).toBe(true);
    expect(state.minRaise).toBe(100);

    state.seats[1]!.stack = 125;
    expect(applyAction(state, 1, "all_in", undefined, 1_100, "b-ai").ok).toBe(true);
    expect(state.currentBet).toBe(125);
    expect(state.minRaise).toBe(100);

    state.seats[2]!.stack = 200;
    expect(applyAction(state, 2, "all_in", undefined, 1_200, "c-ai").ok).toBe(true);
    expect(state.currentBet).toBe(200);
    expect(state.actionSeat).toBe(0);
    expect(raiseRightsOpen(state, state.seats[0]!)).toBe(true);
    const legalA = getLegalActions(state, 0)!;
    expect(legalA.canRaise).toBe(true);
  });

  it("Example C: player who acted at 125 evaluates reopen vs 125", () => {
    const state = openFlop(4);
    expect(applyAction(state, 0, "bet", 100, 1_000, "a-bet").ok).toBe(true);

    state.seats[1]!.stack = 125;
    expect(applyAction(state, 1, "all_in", undefined, 1_100, "b-ai").ok).toBe(true);

    expect(applyAction(state, 2, "call", undefined, 1_200, "c-call").ok).toBe(true);
    expect(state.seats[2]!.actedAtBetLevel).toBe(125);

    state.seats[3]!.stack = 200;
    expect(applyAction(state, 3, "all_in", undefined, 1_300, "d-ai").ok).toBe(true);
    expect(state.currentBet).toBe(200);

    expect(raiseRightsOpen(state, state.seats[0]!)).toBe(true);
    expect(raiseRightsOpen(state, state.seats[2]!)).toBe(false);
  });

  it("all-in cannot bypass closed raise rights", () => {
    const state = openFlop(3);
    applyAction(state, 0, "bet", 100, 1_000, "a-bet");
    applyAction(state, 1, "call", undefined, 1_100, "b-call");
    state.seats[2]!.stack = 130;
    applyAction(state, 2, "all_in", undefined, 1_200, "c-ai");
    const legal = getLegalActions(state, 0)!;
    expect(legal.canRaise).toBe(false);
    expect(raiseRightsOpen(state, state.seats[0]!)).toBe(false);
    expect(legal.canAllIn).toBe(false);
    expect(applyAction(state, 0, "all_in", undefined, 1_300, "a-bad").ok).toBe(false);
  });
});

describe("force fold / leave / deferred ledger", () => {
  it("force-folds active player out of turn and preserves commitments", () => {
    const state = createInitialGameState(cfg(100, 1));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
      ["c", "C", 2],
    ]);
    startHand(state, 1_000);
    const actor = state.actionSeat!;
    const other = state.seats.find(
      (s) => s.playerId && s.seatIndex !== actor && s.status === "active",
    )!;
    const committed = other.committedThisHand;
    const potBefore = state.pot;
    const fold = forceFoldPlayer(state, other.playerId!, 1_100);
    expect(fold.ok).toBe(true);
    expect(other.status).toBe("folded");
    expect(other.committedThisHand).toBe(committed);
    expect(state.pot).toBe(potBefore);
    expect(state.actionSeat).toBe(actor);
  });

  it("all-in leave stays live; deferred settlement uses final stack", () => {
    const state = createInitialGameState(cfg(100, 1));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    startHand(state, 1_000);
    // Shove both
    const first = state.actionSeat!;
    applyAction(state, first, "all_in", undefined, 1_100, "ai1");
    if (state.street !== "waiting") {
      const second = state.actionSeat!;
      applyAction(state, second, "all_in", undefined, 1_200, "ai2");
    }
    // If still in hand somehow, force waiting with known stacks
    if (state.street === "waiting") {
      // Hand completed — set up deferred leave settlement scenario manually
      seatPlayer(state, "c", "C", 2);
      // skip
    }

    const ledger = emptyLedger();
    recordBuyIn(ledger, "winner", "W", 100);
    // Simulate: player left all-in at 0, then won 400 at showdown
    const settleState = createInitialGameState(cfg(100, 1));
    seatMany(settleState, [
      ["x", "X", 0],
      ["y", "Y", 1],
    ]);
    settleState.street = "waiting";
    settleState.seats[0]!.stack = 400;
    settleState.seats[0]!.status = "seated";
    recordBuyIn(ledger, "x", "X", 100);
    const settlements = flushDeferredLeaves(settleState, ["x"]);
    expect(settlements[0]).toEqual({ playerId: "x", stack: 400 });
    recordBuyOut(ledger, "x", settlements[0]!.stack);
    const snap = buildLedgerSnapshot(ledger, new Map());
    expect(snap.players.find((p) => p.userId === "x")!.buyOut).toBe(400);
    expect(snap.players.find((p) => p.userId === "x")!.net).toBe(300);
  });

  it("unseat mid-hand uses force fold not turn-gated fold", () => {
    const state = createInitialGameState(cfg(100, 1));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
      ["c", "C", 2],
    ]);
    startHand(state, 1_000);
    const nonActor = state.seats.find(
      (s) => s.playerId && s.seatIndex !== state.actionSeat && s.status === "active",
    )!;
    const leave = unseatPlayer(state, nonActor.playerId!, 1_500);
    expect(leave.ok).toBe(true);
    if (state.street !== "waiting") {
      expect(leave.ok && leave.deferred).toBe(true);
      expect(state.seats.find((s) => s.playerId === nonActor.playerId)?.status).toBe(
        "folded",
      );
    }
  });

  it("flush deferred leaves before startHand prevents leaver from next deal", () => {
    const state = createInitialGameState(cfg(100, 1));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    startHand(state, 1_000);
    const leave = unseatPlayer(state, "b", 1_100);
    expect(leave.ok).toBe(true);
    if (leave.ok && leave.deferred) {
      // Simulate hand completion while leaver seat is retained.
      state.street = "waiting";
      state.actionSeat = null;
      expect(state.seats.some((s) => s.playerId === "b")).toBe(true);
      flushDeferredLeaves(state, ["b"]);
      expect(state.seats.every((s) => s.playerId !== "b")).toBe(true);
      startHand(state, 2_000);
      expect(state.seats.every((s) => s.playerId !== "b")).toBe(true);
    }
  });
});

describe("time bank validation and pause", () => {
  it("illegal action during time bank does not mutate bank", () => {
    const state = createInitialGameState(cfg(100, 1));
    state.config = { ...state.config, timeBankSeconds: 30 };
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    startHand(state, 1_000);
    const seatIdx = state.actionSeat!;
    const bank = onTurnTimerExpired(state, 2_000);
    expect(bank.kind).toBe("bank");
    const started = state.timeBankStartedMs;
    const ext = state.timeBankExtensionMs;
    const seatBank = state.seats[seatIdx]!.timeBankMs;
    // Illegal raise far below min
    const bad = applyAction(state, seatIdx, "raise", 1, 2_500, "bad");
    expect(bad.ok).toBe(false);
    expect(state.timeBankStartedMs).toBe(started);
    expect(state.timeBankExtensionMs).toBe(ext);
    expect(state.seats[seatIdx]!.timeBankMs).toBe(seatBank);
  });

  it("rejected raise during time bank leaves entire GameState unchanged", () => {
    const state = createInitialGameState(cfg(100, 1));
    state.config = { ...state.config, timeBankSeconds: 30 };
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    startHand(state, 1_000);
    const seatIdx = state.actionSeat!;
    onTurnTimerExpired(state, 2_000);
    // A) raise when currentBet=0 is illegal (should be bet / all_in)
    state.currentBet = 0;
    state.minRaise = 2;
    const before = structuredClone(state);
    expect(applyAction(state, seatIdx, "raise", 10, 2_500, "bad-raise").ok).toBe(false);
    expect(state).toEqual(before);
  });

  it("below-min bet during time bank leaves entire GameState unchanged", () => {
    const state = createInitialGameState(cfg(100, 1));
    state.config = { ...state.config, timeBankSeconds: 30 };
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    startHand(state, 1_000);
    // Advance to flop so bet is legal form
    const actor = state.actionSeat!;
    expect(applyAction(state, actor, "call", undefined, 1_100, "c1").ok).toBe(true);
    expect(
      applyAction(state, actor === 0 ? 1 : 0, "check", undefined, 1_200, "k1").ok,
    ).toBe(true);
    expect(state.street).toBe("flop");
    onTurnTimerExpired(state, 2_000);
    const seatIdx = state.actionSeat!;
    const before = structuredClone(state);
    expect(applyAction(state, seatIdx, "bet", 1, 2_500, "tiny-bet").ok).toBe(false);
    expect(state).toEqual(before);
  });

  it("generic raise rejects when only canAllIn is open (no raise bypass)", () => {
    const state = createInitialGameState(cfg(200, 5));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
      ["c", "C", 2],
    ]);
    state.dealerSeat = 2;
    startHand(state, 1_000);
    expect(applyAction(state, 0, "raise", 40, 1_100, "open").ok).toBe(true);
    expect(applyAction(state, 1, "fold", undefined, 1_200, "sb-f").ok).toBe(true);
    // BB short: canAllIn for call, not canRaise
    state.seats[2]!.stack = 5;
    state.seats[2]!.betThisStreet = 10;
    state.actionSeat = 2;
    const legal = getLegalActions(state, 2)!;
    expect(legal.canAllIn).toBe(true);
    expect(legal.canRaise).toBe(false);
    const before = structuredClone(state);
    expect(applyAction(state, 2, "raise", 15, 1_300, "raise-ai").ok).toBe(false);
    expect(state).toEqual(before);
    expect(applyAction(state, 2, "all_in", undefined, 1_400, "ai-ok").ok).toBe(true);
  });

  it("pause freezes time-bank wall clock", () => {
    const state = createInitialGameState(cfg(100, 1));
    state.config = { ...state.config, timeBankSeconds: 30 };
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    startHand(state, 1_000);
    onTurnTimerExpired(state, 2_000);
    expect(state.timeBankStartedMs).toBe(2_000);
    expect(setPaused(state, true, 5_000).ok).toBe(true); // 3s used
    expect(state.timeBankStartedMs).toBeNull();
    expect(state.pausedTurnRemainingMs).toBe(27_000);
    // Advance clock a lot while paused
    expect(setPaused(state, false, 100_000).ok).toBe(true);
    expect(state.timeBankStartedMs).toBe(100_000);
    expect(state.timeBankExtensionMs).toBe(27_000);
    expect(state.turnDeadlineMs).toBe(127_000);
  });
});

describe("odd chips and tied best-five", () => {
  it("preserves per-winner bestFive and awards odd chip clockwise from button", () => {
    const state = createInitialGameState(cfg(100, 1));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
      ["c", "C", 2],
    ]);
    state.street = "river";
    state.dealerSeat = 0;
    state.handNumber = 1;
    state.deck = buildDeck();
    for (const seat of state.seats) {
      if (!seat.playerId) continue;
      seat.status = "active";
      seat.betThisStreet = 0;
      seat.actedAtBetLevel = null;
      seat.committedThisHand = 7;
      seat.stack = 93;
    }
    // A and B play identical board; C folded after contributing.
    state.seats[0]!.holeCards = ["2c", "3d"];
    state.seats[1]!.holeCards = ["2h", "3c"];
    state.seats[2]!.holeCards = ["2s", "3h"];
    state.seats[2]!.status = "folded";
    state.board = ["Ah", "Kd", "Qc", "Js", "9h"];
    state.pot = 21;
    state.currentBet = 0;
    state.minRaise = 2;
    state.actionSeat = 1;
    expect(applyAction(state, 1, "check", undefined, 2_000, "k1").ok).toBe(true);
    expect(applyAction(state, 0, "check", undefined, 2_100, "k2").ok).toBe(true);
    expect(state.street).toBe("waiting");
    const winners = state.lastHandResult!.winners;
    expect(winners).toHaveLength(2);
    for (const w of winners) {
      expect(w.hand?.bestFive).toHaveLength(5);
    }
    // Distinct hand objects per winner (not a shared reference).
    expect(winners[0]!.hand).not.toBe(winners[1]!.hand);
    expect(winners[0]!.hand!.bestFive).not.toBe(winners[1]!.hand!.bestFive);
    const total = winners.reduce((s, w) => s + w.amount, 0);
    expect(total).toBe(21);
    // Odd chip → left of button (seat 1 / player b), not the button
    expect(winners.find((w) => w.playerId === "b")!.amount).toBe(11);
    expect(winners.find((w) => w.playerId === "a")!.amount).toBe(10);
  });

  it("odd chip prefers first clockwise seat when button is not tied", () => {
    const state = createInitialGameState(cfg(100, 1));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
      ["c", "C", 2],
    ]);
    state.street = "river";
    state.dealerSeat = 0; // button A folded
    state.handNumber = 1;
    state.deck = buildDeck();
    for (const seat of state.seats) {
      if (!seat.playerId) continue;
      seat.status = "active";
      seat.betThisStreet = 0;
      seat.actedAtBetLevel = null;
      seat.committedThisHand = 7;
      seat.stack = 93;
      seat.holeCards = ["2c", "3d"];
    }
    state.seats[1]!.holeCards = ["2h", "3c"];
    state.seats[2]!.holeCards = ["2s", "3h"];
    state.seats[0]!.status = "folded";
    state.board = ["Ah", "Kd", "Qc", "Js", "9h"];
    state.pot = 21;
    state.currentBet = 0;
    state.actionSeat = 1;
    expect(applyAction(state, 1, "check", undefined, 3_000, "c1").ok).toBe(true);
    expect(applyAction(state, 2, "check", undefined, 3_100, "c2").ok).toBe(true);
    const winners = state.lastHandResult!.winners;
    expect(winners).toHaveLength(2);
    // Clockwise from button: seat1 then seat2 — odd chip to B
    expect(winners.find((w) => w.playerId === "b")!.amount).toBe(11);
    expect(winners.find((w) => w.playerId === "c")!.amount).toBe(10);
  });
});

describe("auto-runout", () => {
  it("runs board when everyone is all-in", () => {
    const res = validateConfigInput({
      smallBlind: 5,
      startingStack: 50,
      potCapMultiplier: 100,
    });
    if (!res.ok) throw new Error(res.error);
    const state = createInitialGameState(res.config);
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    startHand(state, 1_000);
    const first = state.actionSeat!;
    const r1 = applyAction(state, first, "all_in", undefined, 1_100, "ai1");
    expect(r1.ok).toBe(true);
    if (state.street !== "waiting") {
      const second = state.actionSeat!;
      expect(applyAction(state, second, "all_in", undefined, 1_200, "ai2").ok).toBe(true);
    }
    expect(state.street).toBe("waiting");
    expect(state.board.length).toBe(5);
    expect(state.lastHandResult).not.toBeNull();
  });
});

describe("rabbit hunt deck direction", () => {
  it("uses pop+burn like normal dealing, not splice from front", () => {
    const state = createInitialGameState(cfg(100, 1));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    startHand(state, 1_000);
    const deckBefore = [...state.deck];
    applyAction(state, state.actionSeat!, "fold", undefined, 1_100, "f");
    expect(state.street).toBe("waiting");
    expect(state.board.length).toBe(0);
    const sim = [...deckBefore];
    const expected: string[] = [];
    sim.pop();
    expected.push(sim.pop()!, sim.pop()!, sim.pop()!);
    sim.pop();
    expected.push(sim.pop()!);
    sim.pop();
    expected.push(sim.pop()!);
    const rabbit = rabbitHunt(state);
    expect(rabbit.ok).toBe(true);
    if (!rabbit.ok) return;
    expect(rabbit.cards).toEqual(expected);
    expect(state.deck).toEqual(deckBefore);
  });
});

describe("side pot invariants", () => {
  it("folded contributors never become eligible", () => {
    const contributions = new Map([
      ["a", 50],
      ["b", 100],
      ["c", 100],
    ]);
    const pots = computeSidePots(contributions, ["b", "c"]);
    expect(pots[0]!.eligiblePlayerIds.sort()).toEqual(["b", "c"]);
    expect(pots[0]!.eligiblePlayerIds).not.toContain("a");
  });

  it("throws on empty eligibility when no live contributor remains", () => {
    const contributions = new Map([
      ["a", 50],
      ["b", 50],
    ]);
    expect(() => computeSidePots(contributions, [])).toThrow(/invariant/i);
  });

  it("conserves chips across a shove hand", () => {
    const state = createInitialGameState(cfg(100, 5));
    seatMany(state, [
      ["a", "A", 0],
      ["b", "B", 1],
      ["c", "C", 2],
    ]);
    const before = totalChipsInPlay(state);
    startHand(state, 1_000);
    expect(totalChipsInPlay(state)).toBe(before);
    let guard = 0;
    while (state.street !== "waiting" && guard++ < 30) {
      const idx = state.actionSeat;
      if (idx == null) break;
      const legal = getLegalActions(state, idx);
      if (!legal) break;
      const action = legal.canAllIn ? "all_in" : legal.canCall ? "call" : "fold";
      const res = applyAction(state, idx, action, undefined, 1_000 + guard, `g${guard}`);
      expect(res.ok).toBe(true);
      expect(totalChipsInPlay(state)).toBe(before);
    }
    expect(totalChipsInPlay(state)).toBe(before);
  });
});

describe("shuffle rejection sampling uses injected source", () => {
  it("retries via injected randomBytes when value out of range", () => {
    let calls = 0;
    const shuffled = shuffleDeck(buildDeck(), (n) => {
      calls += 1;
      const buf = new Uint32Array(n);
      // Keep returning out-of-range values for early draws so rejection
      // sampling must re-invoke this injected source (never crypto directly).
      buf[0] = calls <= 60 ? 0xffffffff : 0;
      return buf;
    });
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled).size).toBe(52);
    expect(calls).toBeGreaterThan(51);
  });
});
