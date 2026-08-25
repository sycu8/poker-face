import type { CSSProperties } from "react";

type Suit = "c" | "d" | "h" | "s";
type Rank = "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T" | "J" | "Q" | "K" | "A";
type Size = "board" | "hole" | "hero";

const RANK_LABEL: Record<Rank, string> = {
  A: "A",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  T: "10",
  J: "J",
  Q: "Q",
  K: "K",
};

const RANK_NAME: Record<Rank, string> = {
  A: "Ace",
  "2": "Two",
  "3": "Three",
  "4": "Four",
  "5": "Five",
  "6": "Six",
  "7": "Seven",
  "8": "Eight",
  "9": "Nine",
  T: "Ten",
  J: "Jack",
  Q: "Queen",
  K: "King",
};

const SUIT_NAME: Record<Suit, string> = {
  h: "hearts",
  d: "diamonds",
  c: "clubs",
  s: "spades",
};

const SUIT_COLOR: Record<Suit, string> = {
  h: "#c41e3a",
  d: "#c41e3a",
  c: "#1a1204",
  s: "#1a1204",
};

const VALID_RANKS = new Set<string>(Object.keys(RANK_LABEL));
const VALID_SUITS = new Set<string>(["c", "d", "h", "s"]);

/** Pip positions in a 63×88 viewBox (x, y). Upside-down pips use flip. */
type Pip = { x: number; y: number; flip?: boolean };

const PIP_LAYOUTS: Record<string, Pip[]> = {
  "2": [
    { x: 31.5, y: 24 },
    { x: 31.5, y: 64, flip: true },
  ],
  "3": [
    { x: 31.5, y: 22 },
    { x: 31.5, y: 44 },
    { x: 31.5, y: 66, flip: true },
  ],
  "4": [
    { x: 20, y: 24 },
    { x: 43, y: 24 },
    { x: 20, y: 64, flip: true },
    { x: 43, y: 64, flip: true },
  ],
  "5": [
    { x: 20, y: 24 },
    { x: 43, y: 24 },
    { x: 31.5, y: 44 },
    { x: 20, y: 64, flip: true },
    { x: 43, y: 64, flip: true },
  ],
  "6": [
    { x: 20, y: 24 },
    { x: 43, y: 24 },
    { x: 20, y: 44 },
    { x: 43, y: 44 },
    { x: 20, y: 64, flip: true },
    { x: 43, y: 64, flip: true },
  ],
  "7": [
    { x: 20, y: 22 },
    { x: 43, y: 22 },
    { x: 31.5, y: 33 },
    { x: 20, y: 44 },
    { x: 43, y: 44 },
    { x: 20, y: 66, flip: true },
    { x: 43, y: 66, flip: true },
  ],
  "8": [
    { x: 20, y: 22 },
    { x: 43, y: 22 },
    { x: 20, y: 36 },
    { x: 43, y: 36 },
    { x: 20, y: 52, flip: true },
    { x: 43, y: 52, flip: true },
    { x: 20, y: 66, flip: true },
    { x: 43, y: 66, flip: true },
  ],
  "9": [
    { x: 20, y: 20 },
    { x: 43, y: 20 },
    { x: 20, y: 34 },
    { x: 43, y: 34 },
    { x: 31.5, y: 44 },
    { x: 20, y: 54, flip: true },
    { x: 43, y: 54, flip: true },
    { x: 20, y: 68, flip: true },
    { x: 43, y: 68, flip: true },
  ],
  T: [
    { x: 20, y: 18 },
    { x: 43, y: 18 },
    { x: 31.5, y: 28 },
    { x: 20, y: 36 },
    { x: 43, y: 36 },
    { x: 20, y: 52, flip: true },
    { x: 43, y: 52, flip: true },
    { x: 31.5, y: 60, flip: true },
    { x: 20, y: 70, flip: true },
    { x: 43, y: 70, flip: true },
  ],
};

function SuitGlyph({
  suit,
  size,
  color,
}: {
  suit: Suit;
  size: number;
  color: string;
}) {
  const s = size;
  if (suit === "h") {
    return (
      <path
        fill={color}
        d={`M ${s * 0.5} ${s * 0.92}
          C ${s * 0.5} ${s * 0.72}, ${s * 0.08} ${s * 0.48}, ${s * 0.08} ${s * 0.3}
          C ${s * 0.08} ${s * 0.12}, ${s * 0.24} ${s * 0.02}, ${s * 0.38} ${s * 0.12}
          C ${s * 0.44} ${s * 0.17}, ${s * 0.5} ${s * 0.28}, ${s * 0.5} ${s * 0.28}
          C ${s * 0.5} ${s * 0.28}, ${s * 0.56} ${s * 0.17}, ${s * 0.62} ${s * 0.12}
          C ${s * 0.76} ${s * 0.02}, ${s * 0.92} ${s * 0.12}, ${s * 0.92} ${s * 0.3}
          C ${s * 0.92} ${s * 0.48}, ${s * 0.5} ${s * 0.72}, ${s * 0.5} ${s * 0.92} Z`}
      />
    );
  }
  if (suit === "d") {
    return (
      <path
        fill={color}
        d={`M ${s * 0.5} ${s * 0.04} L ${s * 0.9} ${s * 0.5} L ${s * 0.5} ${s * 0.96} L ${s * 0.1} ${s * 0.5} Z`}
      />
    );
  }
  if (suit === "s") {
    return (
      <g fill={color}>
        <path
          d={`M ${s * 0.5} ${s * 0.04}
            C ${s * 0.5} ${s * 0.04}, ${s * 0.12} ${s * 0.36}, ${s * 0.12} ${s * 0.52}
            C ${s * 0.12} ${s * 0.66}, ${s * 0.26} ${s * 0.74}, ${s * 0.38} ${s * 0.68}
            C ${s * 0.34} ${s * 0.78}, ${s * 0.3} ${s * 0.88}, ${s * 0.28} ${s * 0.94}
            L ${s * 0.72} ${s * 0.94}
            C ${s * 0.7} ${s * 0.88}, ${s * 0.66} ${s * 0.78}, ${s * 0.62} ${s * 0.68}
            C ${s * 0.74} ${s * 0.74}, ${s * 0.88} ${s * 0.66}, ${s * 0.88} ${s * 0.52}
            C ${s * 0.88} ${s * 0.36}, ${s * 0.5} ${s * 0.04}, ${s * 0.5} ${s * 0.04} Z`}
        />
        <rect x={s * 0.42} y={s * 0.72} width={s * 0.16} height={s * 0.22} rx={s * 0.02} />
      </g>
    );
  }
  return (
    <g fill={color}>
      <circle cx={s * 0.5} cy={s * 0.28} r={s * 0.2} />
      <circle cx={s * 0.28} cy={s * 0.52} r={s * 0.2} />
      <circle cx={s * 0.72} cy={s * 0.52} r={s * 0.2} />
      <path
        d={`M ${s * 0.5} ${s * 0.42}
          L ${s * 0.58} ${s * 0.72}
          L ${s * 0.68} ${s * 0.94}
          L ${s * 0.32} ${s * 0.94}
          L ${s * 0.42} ${s * 0.72} Z`}
      />
    </g>
  );
}

function CornerIndex({
  rank,
  suit,
  color,
  inverted,
}: {
  rank: Rank;
  suit: Suit;
  color: string;
  inverted?: boolean;
}) {
  const label = RANK_LABEL[rank];
  const suitSize = label === "10" ? 9 : 10;
  const transform = inverted ? "rotate(180 31.5 44)" : undefined;
  return (
    <g transform={transform} fill={color}>
      <text
        x={8}
        y={14}
        textAnchor="middle"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontWeight={700}
        fontSize={label === "10" ? 11 : 13}
        fill={color}
      >
        {label}
      </text>
      <g transform={`translate(${8 - suitSize / 2}, 16)`}>
        <SuitGlyph suit={suit} size={suitSize} color={color} />
      </g>
    </g>
  );
}

function CardFace({ rank, suit }: { rank: Rank; suit: Suit }) {
  const color = SUIT_COLOR[suit];
  const pips = PIP_LAYOUTS[rank];

  return (
    <svg
      className="playing-card-face"
      viewBox="0 0 63 88"
      width="100%"
      height="100%"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0.5" y="0.5" width="62" height="87" rx="6" ry="6" fill="#fffef8" stroke="#d9d2c3" />
      <CornerIndex rank={rank} suit={suit} color={color} />
      <CornerIndex rank={rank} suit={suit} color={color} inverted />

      {pips ? (
        pips.map((pip, i) => {
          const size = 14;
          const tx = pip.x - size / 2;
          const ty = pip.y - size / 2;
          const rot = pip.flip ? `rotate(180 ${pip.x} ${pip.y})` : undefined;
          return (
            <g key={i} transform={rot}>
              <g transform={`translate(${tx}, ${ty})`}>
                <SuitGlyph suit={suit} size={size} color={color} />
              </g>
            </g>
          );
        })
      ) : (
        <g transform="translate(15.5, 26)">
          <SuitGlyph suit={suit} size={32} color={color} />
        </g>
      )}
    </svg>
  );
}

function parseCode(code: string): { rank: Rank; suit: Suit } | null {
  if (code.length !== 2) return null;
  const rank = code[0]!;
  const suit = code[1]!;
  if (!VALID_RANKS.has(rank) || !VALID_SUITS.has(suit)) return null;
  return { rank: rank as Rank, suit: suit as Suit };
}

export function cardAriaLabel(code: string): string {
  if (code === "?") return "Hidden card";
  const parsed = parseCode(code);
  if (!parsed) return code;
  return `${RANK_NAME[parsed.rank]} of ${SUIT_NAME[parsed.suit]}`;
}

export interface PlayingCardProps {
  code: string;
  size?: Size;
  className?: string;
  style?: CSSProperties;
}

const SIZE_CLASS: Record<Size, string> = {
  board: "playing-card--board",
  hole: "playing-card--hole",
  hero: "playing-card--hero",
};

export function PlayingCard({ code, size = "board", className = "", style }: PlayingCardProps) {
  const parsed = code === "?" ? null : parseCode(code);
  const isBack = code === "?" || !parsed;
  const classes = ["playing-card", SIZE_CLASS[size], isBack ? "playing-card--back" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      style={style}
      role="img"
      aria-label={cardAriaLabel(isBack ? "?" : code)}
    >
      {parsed ? <CardFace rank={parsed.rank} suit={parsed.suit} /> : null}
    </div>
  );
}
