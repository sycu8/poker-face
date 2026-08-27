/** Card ranks and suits for Texas Hold'em. */

export const SUITS = ["c", "d", "h", "s"] as const;
export const RANKS = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "T",
  "J",
  "Q",
  "K",
  "A",
] as const;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];
export type Card = `${Rank}${Suit}`;

export function rankValue(rank: Rank): number {
  return RANKS.indexOf(rank);
}

export function parseCard(card: string): { rank: Rank; suit: Suit } {
  if (card.length !== 2) throw new Error(`Invalid card: ${card}`);
  const rank = card[0] as Rank;
  const suit = card[1] as Suit;
  if (!RANKS.includes(rank) || !SUITS.includes(suit)) {
    throw new Error(`Invalid card: ${card}`);
  }
  return { rank, suit };
}

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(`${rank}${suit}`);
    }
  }
  return deck;
}

/** Unbiased Fisher–Yates using crypto.getRandomValues (or injected source for tests). */
export function shuffleDeck(
  deck: Card[],
  randomBytes?: (n: number) => Uint32Array,
): Card[] {
  const out = [...deck];
  const get =
    randomBytes ??
    ((n: number) => {
      const buf = new Uint32Array(n);
      crypto.getRandomValues(buf);
      return buf;
    });
  for (let i = out.length - 1; i > 0; i--) {
    // Rejection sampling for unbiased index in [0, i] — all draws use `get`.
    const max = 0x100000000;
    const limit = max - (max % (i + 1));
    let x = get(1)[0]!;
    while (x >= limit) {
      x = get(1)[0]!;
    }
    const j = x % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
