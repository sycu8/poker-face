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
    // Even if everyone folded into a pot incorrectly, keep amount on last eligible set
    pots.push({
      amount,
      eligiblePlayerIds: potEligible.length > 0 ? potEligible : contributors.map(([id]) => id),
    });
    prev = level;
  }
  return pots;
}

export function totalPot(pots: SidePot[]): number {
  return pots.reduce((s, p) => s + p.amount, 0);
}
