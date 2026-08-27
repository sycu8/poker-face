import { describe, expect, it } from "vitest";
import {
  chooseBotAction,
  isBotUserId,
  nextBotDisplayName,
} from "../../worker/domain/bots";
import type { LegalActions } from "../../worker/domain/engine";

function legal(partial: Partial<LegalActions>): LegalActions {
  return {
    canFold: true,
    canCheck: false,
    canCall: false,
    callAmount: 0,
    callIsAllIn: false,
    canBet: false,
    canRaise: false,
    canShortAllInRaise: false,
    minBet: 2,
    maxBet: 100,
    minRaiseTo: 4,
    maxRaiseTo: 100,
    canAllIn: true,
    allInAmount: 100,
    ...partial,
  };
}

describe("bots helpers", () => {
  it("detects bot user ids", () => {
    expect(isBotUserId("bot_abc")).toBe(true);
    expect(isBotUserId("usr_abc")).toBe(false);
    expect(isBotUserId(null)).toBe(false);
  });

  it("picks next Bot N name", () => {
    expect(nextBotDisplayName([])).toBe("Bot 1");
    expect(nextBotDisplayName(["Ada", "Bot 1", "Bot 3"])).toBe("Bot 2");
  });

  it("checks when free", () => {
    expect(chooseBotAction(legal({ canCheck: true, canBet: false }))).toEqual({
      action: "check",
    });
  });

  it("calls modest bets and folds big ones", () => {
    expect(chooseBotAction(legal({ canCall: true, callAmount: 4, minBet: 2 }))).toEqual({
      action: "call",
    });
    expect(chooseBotAction(legal({ canCall: true, callAmount: 40, minBet: 2 }))).toEqual({
      action: "fold",
    });
  });
});

describe("bot seat flow (domain)", () => {
  it("bots can be seated in open seats and act until humans", async () => {
    const {
      createInitialGameState,
      seatPlayer,
      startHand,
      applyAction,
      getLegalActions,
    } = await import("../../worker/domain/engine");
    const { chooseBotAction, isBotUserId, nextBotDisplayName } =
      await import("../../worker/domain/bots");

    const state = createInitialGameState({
      smallBlind: 1,
      bigBlind: 2,
      startingStack: 100,
      potCapMultiplier: 2,
      turnTimeoutMs: 30_000,
      maxSeats: 6,
      timeBankSeconds: 60,
    });
    seatPlayer(state, "usr_host", "Host", 0);
    const name1 = nextBotDisplayName(state.seats.map((s) => s.displayName));
    seatPlayer(state, "bot_one", name1, 1);
    const name2 = nextBotDisplayName(state.seats.map((s) => s.displayName));
    seatPlayer(state, "bot_two", name2, 2);
    expect(name1).toBe("Bot 1");
    expect(name2).toBe("Bot 2");

    startHand(state, 1_000);
    let guard = 0;
    while (guard++ < 40 && state.street !== "waiting" && state.actionSeat !== null) {
      const seat = state.seats[state.actionSeat]!;
      if (!isBotUserId(seat.playerId)) break;
      const legal = getLegalActions(state, seat.seatIndex);
      expect(legal).not.toBeNull();
      const decision = chooseBotAction(legal!);
      const result = applyAction(
        state,
        seat.seatIndex,
        decision.action,
        decision.amount,
        1_000 + guard,
        `bot-test:${guard}`,
      );
      expect(result.ok).toBe(true);
    }
    // Eventually either hand ends or a non-bot (host) must act.
    if (state.street !== "waiting" && state.actionSeat !== null) {
      const actor = state.seats[state.actionSeat]!;
      expect(isBotUserId(actor.playerId)).toBe(false);
    }
  });
});
