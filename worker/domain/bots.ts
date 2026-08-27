import type { ActionType } from "./engine";
import type { LegalActions } from "./engine";

export function isBotUserId(userId: string | null | undefined): boolean {
  return Boolean(userId && userId.startsWith("bot_"));
}

/** Next unused “Bot N” label from currently seated display names. */
export function nextBotDisplayName(
  seatedNames: Array<string | null | undefined>,
): string {
  const used = new Set(
    seatedNames.filter((n): n is string => Boolean(n)).map((n) => n.trim().toLowerCase()),
  );
  let n = 1;
  while (used.has(`bot ${n}`)) n += 1;
  return `Bot ${n}`;
}

export type BotDecision = { action: ActionType; amount?: number };

/**
 * Conservative practice-table bot: check when free, call modest bets, fold to pressure.
 * Never needs hole cards (works from legal actions alone).
 */
export function chooseBotAction(legal: LegalActions): BotDecision {
  if (legal.canCheck) {
    if (legal.canBet && legal.minBet > 0 && legal.maxBet >= legal.minBet) {
      // Occasional min-bet to keep pots alive (~1 in 4 free checks).
      const sprinkle = (legal.minBet + legal.maxBet + legal.callAmount) % 4 === 0;
      if (sprinkle) {
        return { action: "bet", amount: legal.minBet };
      }
    }
    return { action: "check" };
  }

  if (legal.canCall || (legal.callAmount > 0 && legal.canAllIn)) {
    const call = legal.callAmount;
    // Call cheap pressure; fold large ones (all-in call only if tiny remaining).
    if (call <= legal.minBet * 4 || (legal.canAllIn && call <= legal.minBet * 2)) {
      if (call >= legal.maxRaiseTo && legal.canAllIn && !legal.canCall) {
        return { action: "all_in" };
      }
      return { action: "call" };
    }
    return { action: "fold" };
  }

  if (legal.canAllIn) return { action: "all_in" };
  return { action: "fold" };
}
