export interface SidePot {
  amount: number;
  eligiblePlayerIds: string[];
}

/**
 * Build side pots from committed amounts this hand (blinds + bets).
 * Players who folded remain eligible only for pots they contributed to before folding
 * — caller passes `activeEligible` as players still in the hand for the current pot split.
 */
export function computeSidePots(
  contributions: Map<string, number>,
  eligiblePlayerIds: string[],
): SidePot[] {
  const eligible = new Set(eligiblePlayerIds);
  const levels = [...new Set([...contributions.values()].filter((v) => v > 0))].sort(
    (a, b) => a - b,
  );
  if (levels.length === 0) return [];

  const pots: SidePot[] = [];
  let prev = 0;
  for (const level of levels) {
    const contributors = [...contributions.entries()].filter(([, amt]) => amt >= level);
    const layer = level - prev;
    const amount = layer * contributors.length;
    if (amount <= 0) {
      prev = level;
      continue;
    }
    const potEligible = contributors
      .map(([id]) => id)
      .filter((id) => eligible.has(id));
    if (potEligible.length === 0) {
      // Dead chips from a layer with only folded contributors: merge into the
      // previous pot (still awarded only to live eligible), or award to remaining
      // in-hand players who contributed. Never fall back to all (folded) contributors.
      if (pots.length > 0) {
        pots[pots.length - 1]!.amount += amount;
        prev = level;
        continue;
      }
      const liveContributors = eligiblePlayerIds.filter(
        (id) => (contributions.get(id) ?? 0) > 0,
      );
      if (liveContributors.length === 0) {
        throw new Error(
          `Side-pot invariant failure: pot layer amount=${amount} has no eligible winners.`,
        );
      }
      pots.push({ amount, eligiblePlayerIds: liveContributors });
      prev = level;
      continue;
    }
    pots.push({
      amount,
      eligiblePlayerIds: potEligible,
    });
    prev = level;
  }
  return pots;
}

export function totalPot(pots: SidePot[]): number {
  return pots.reduce((s, p) => s + p.amount, 0);
}
