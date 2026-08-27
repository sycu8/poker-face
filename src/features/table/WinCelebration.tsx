/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState } from "react";
import { PlayingCard } from "./PlayingCard";

export interface WinCelebrationWinner {
  playerId: string;
  amount: number;
  potIndex: number;
  hand?: {
    category: string;
    label: string;
    bestFive: string[];
    strength: number[];
  };
}

export interface WinCelebrationProps {
  winners: WinCelebrationWinner[];
  displayNameFor: (playerId: string) => string;
  /** Bumps when a new hand starts so the overlay dismisses. */
  handNumber: number;
  onDismiss?: () => void;
  /** Auto-hide duration in ms (default 4500). */
  durationMs?: number;
}

export interface PotSummary {
  potIndex: number;
  label: string | null;
  bestFive: string[] | null;
  names: string[];
  amount: number;
}

export function summarizePots(
  winners: WinCelebrationWinner[],
  displayNameFor: (playerId: string) => string,
): PotSummary[] {
  const byPot = new Map<number, PotSummary>();
  for (const w of winners) {
    let row = byPot.get(w.potIndex);
    if (!row) {
      row = {
        potIndex: w.potIndex,
        label: w.hand?.label ?? null,
        bestFive: w.hand?.bestFive ?? null,
        names: [],
        amount: 0,
      };
      byPot.set(w.potIndex, row);
    }
    row.names.push(displayNameFor(w.playerId));
    row.amount += w.amount;
    if (!row.label && w.hand?.label) {
      row.label = w.hand.label;
      row.bestFive = w.hand.bestFive;
    }
  }
  return [...byPot.values()].sort((a, b) => a.potIndex - b.potIndex);
}

/** Codes from contested winning best-five hands (for board / hole highlighting). */
export function winningBestFiveCodes(winners: WinCelebrationWinner[]): Set<string> {
  const codes = new Set<string>();
  for (const w of winners) {
    for (const c of w.hand?.bestFive ?? []) codes.add(c);
  }
  return codes;
}

function BestFiveCards({ cards, label }: { cards: string[]; label: string }) {
  return (
    <div className="win-celebration__cards" aria-label={label}>
      {cards.map((c, i) => (
        <span key={`${c}-${i}`} className="win-celebration__card">
          <PlayingCard code={c} size="board" className="win-celebration__face" />
        </span>
      ))}
    </div>
  );
}

export function WinCelebration({
  winners,
  displayNameFor,
  handNumber,
  onDismiss,
  durationMs = 4500,
}: WinCelebrationProps) {
  const [visible, setVisible] = useState(true);
  const [exiting, setExiting] = useState(false);

  const pots = useMemo(
    () => summarizePots(winners, displayNameFor),
    [winners, displayNameFor],
  );

  const contested = pots.filter((p) => p.bestFive && p.bestFive.length > 0);
  const primary = pots[0];
  const multiPot = pots.length > 1;
  const title = multiPot
    ? contested.length > 1
      ? "Split pots"
      : (primary?.label ?? "Winner")
    : (primary?.label ?? "Winner");
  const subtitle = multiPot
    ? pots
        .map((p) => {
          const potName = p.potIndex === 0 ? "Main pot" : `Side pot ${p.potIndex}`;
          const rank = p.label ?? "takes it";
          const who = p.names.length ? ` · ${p.names.join(" & ")}` : "";
          return `${potName}: ${rank}${who}`;
        })
        .join(" · ")
    : (primary?.names.join(" & ") ?? "");

  useEffect(() => {
    setVisible(true);
    setExiting(false);
    const fadeId = window.setTimeout(
      () => setExiting(true),
      Math.max(0, durationMs - 400),
    );
    const hideId = window.setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, durationMs);
    return () => {
      window.clearTimeout(fadeId);
      window.clearTimeout(hideId);
    };
  }, [handNumber, winners, durationMs, onDismiss]);

  if (!visible || winners.length === 0) return null;

  return (
    <div
      className={`win-celebration${exiting ? " win-celebration--exit" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={`${title}. ${subtitle}`}
    >
      <div className="win-celebration__panel">
        <p className="win-celebration__eyebrow">
          {contested.length > 0 ? "Showdown" : "Winner"}
        </p>
        <h2 className="win-celebration__rank">{title}</h2>
        {subtitle ? <p className="win-celebration__names">{subtitle}</p> : null}

        {!multiPot && primary?.bestFive && primary.bestFive.length > 0 ? (
          <BestFiveCards cards={primary.bestFive} label="Winning five cards" />
        ) : null}

        {multiPot
          ? pots.map((p) => {
              const potName = p.potIndex === 0 ? "Main pot" : `Side pot ${p.potIndex}`;
              return (
                <div key={p.potIndex} className="win-celebration__pot">
                  <p className="win-celebration__side">
                    {potName}: <strong>{p.label ?? "takes it"}</strong>
                    {p.names.length ? ` · ${p.names.join(" & ")}` : ""}
                  </p>
                  {p.bestFive && p.bestFive.length > 0 ? (
                    <BestFiveCards
                      cards={p.bestFive}
                      label={`${potName} winning five cards`}
                    />
                  ) : null}
                </div>
              );
            })
          : null}
      </div>
    </div>
  );
}

/** Player ids that should pulse as winners for this result. */
export function winningPlayerIds(winners: WinCelebrationWinner[]): Set<string> {
  return new Set(winners.map((w) => w.playerId));
}
