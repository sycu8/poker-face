/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState } from "react";

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

interface PotSummary {
  potIndex: number;
  label: string | null;
  bestFive: string[] | null;
  names: string[];
  amount: number;
}

function summarizePots(
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

  const primary = pots[0];
  const title = primary?.label ?? "Winner";
  const subtitle =
    pots.length > 1
      ? pots
          .map((p) => {
            const potName = p.potIndex === 0 ? "Main pot" : `Side pot ${p.potIndex}`;
            const rank = p.label ?? "takes it";
            return `${potName}: ${rank}`;
          })
          .join(" · ")
      : primary?.names.join(" & ") ?? "";

  useEffect(() => {
    setVisible(true);
    setExiting(false);
    const fadeId = window.setTimeout(() => setExiting(true), Math.max(0, durationMs - 400));
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
        <p className="win-celebration__eyebrow">Showdown</p>
        <h2 className="win-celebration__rank">{title}</h2>
        {subtitle ? <p className="win-celebration__names">{subtitle}</p> : null}
        {primary?.bestFive && primary.bestFive.length > 0 ? (
          <div className="win-celebration__cards" aria-label="Winning five cards">
            {primary.bestFive.map((c) => (
              <span key={c} className="win-celebration__card">
                {c}
              </span>
            ))}
          </div>
        ) : null}
        {pots.length > 1
          ? pots.slice(1).map((p) =>
              p.label ? (
                <p key={p.potIndex} className="win-celebration__side">
                  Side pot {p.potIndex}: <strong>{p.label}</strong>
                  {p.names.length ? ` · ${p.names.join(" & ")}` : ""}
                </p>
              ) : null,
            )
          : null}
      </div>
    </div>
  );
}

/** Player ids that should pulse as winners for this result. */
export function winningPlayerIds(winners: WinCelebrationWinner[]): Set<string> {
  return new Set(winners.map((w) => w.playerId));
}
