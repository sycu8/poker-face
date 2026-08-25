import { type Card, parseCard, rankValue, type Rank } from "./cards";

export type HandCategory =
  | "high_card"
  | "one_pair"
  | "two_pair"
  | "three_of_a_kind"
  | "straight"
  | "flush"
  | "full_house"
  | "four_of_a_kind"
  | "straight_flush";

const CATEGORY_RANK: Record<HandCategory, number> = {
  high_card: 0,
  one_pair: 1,
  two_pair: 2,
  three_of_a_kind: 3,
  straight: 4,
  flush: 5,
  full_house: 6,
  four_of_a_kind: 7,
  straight_flush: 8,
};

export interface EvaluatedHand {
  category: HandCategory;
  /** Descending tie-breakers (rank values). */
  ranks: number[];
  bestFive: Card[];
}

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  if (first === undefined) return [];
  const withFirst = combinations(rest, k - 1).map((c) => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

function straightHigh(sortedUniqueDesc: number[]): number | null {
  if (sortedUniqueDesc.length < 5) return null;
  for (let i = 0; i <= sortedUniqueDesc.length - 5; i++) {
    const slice = sortedUniqueDesc.slice(i, i + 5);
    if (slice[0]! - slice[4]! === 4) return slice[0]!;
  }
  // Wheel: A-5-4-3-2
  const set = new Set(sortedUniqueDesc);
  if (set.has(12) && set.has(3) && set.has(2) && set.has(1) && set.has(0)) {
    return 3; // 5-high
  }
  return null;
}

function evaluateFive(cards: Card[]): EvaluatedHand {
  const parsed = cards.map(parseCard);
  const rankCounts = new Map<number, number>();
  const suitCounts = new Map<string, number>();
  for (const p of parsed) {
    const v = rankValue(p.rank);
    rankCounts.set(v, (rankCounts.get(v) ?? 0) + 1);
    suitCounts.set(p.suit, (suitCounts.get(p.suit) ?? 0) + 1);
  }
  const isFlush = [...suitCounts.values()].some((c) => c === 5);
  const uniqueRanks = [...rankCounts.keys()].sort((a, b) => b - a);
  const sHigh = straightHigh(uniqueRanks);
  const isStraight = sHigh !== null;

  const byCount = [...rankCounts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });

  let category: HandCategory;
  let ranks: number[];

  if (isStraight && isFlush) {
    category = "straight_flush";
    ranks = [sHigh!];
  } else if (byCount[0]?.[1] === 4) {
    category = "four_of_a_kind";
    ranks = [byCount[0][0], byCount[1]![0]];
  } else if (byCount[0]?.[1] === 3 && byCount[1]?.[1] === 2) {
    category = "full_house";
    ranks = [byCount[0][0], byCount[1][0]];
  } else if (isFlush) {
    category = "flush";
    ranks = uniqueRanks;
  } else if (isStraight) {
    category = "straight";
    ranks = [sHigh!];
  } else if (byCount[0]?.[1] === 3) {
    category = "three_of_a_kind";
    ranks = [byCount[0][0], ...byCount.slice(1).map(([r]) => r)];
  } else if (byCount[0]?.[1] === 2 && byCount[1]?.[1] === 2) {
    category = "two_pair";
    const pairs = [byCount[0][0], byCount[1][0]].sort((a, b) => b - a);
    ranks = [...pairs, byCount[2]![0]];
  } else if (byCount[0]?.[1] === 2) {
    category = "one_pair";
    ranks = [byCount[0][0], ...byCount.slice(1).map(([r]) => r)];
  } else {
    category = "high_card";
    ranks = uniqueRanks;
  }

  return { category, ranks, bestFive: cards };
}

export function compareHands(a: EvaluatedHand, b: EvaluatedHand): number {
  const cat = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
  if (cat !== 0) return cat;
  const n = Math.max(a.ranks.length, b.ranks.length);
  for (let i = 0; i < n; i++) {
    const d = (a.ranks[i] ?? -1) - (b.ranks[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** Best 5-card hand from 5–7 cards (hole + board). */
export function evaluateBestHand(cards: Card[]): EvaluatedHand {
  if (cards.length < 5) throw new Error("Need at least 5 cards");
  if (cards.length === 5) return evaluateFive(cards);
  let best: EvaluatedHand | null = null;
  for (const five of combinations(cards, 5)) {
    const ev = evaluateFive(five);
    if (!best || compareHands(ev, best) > 0) best = ev;
  }
  return best!;
}

export function categoryLabel(category: HandCategory): string {
  return category.replaceAll("_", " ");
}

export function rankLabel(rank: Rank): string {
  return rank === "T" ? "10" : rank;
}
