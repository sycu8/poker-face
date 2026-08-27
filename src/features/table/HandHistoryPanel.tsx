import { useEffect, useState } from "react";
import { api, type HandSummaryListItem } from "../../lib/api";
import { PlayingCard } from "../table/PlayingCard";

type HandResultShape = {
  winners?: Array<{
    playerId: string;
    amount: number;
    potIndex: number;
    hand?: { label?: string; bestFive?: string[] };
  }>;
  shownHands?: Array<{ playerId: string; cards: [string, string] }>;
  pots?: Array<{ amount: number }>;
};

/**
 * Simple hand history list + replay viewer for archived hands.
 */
export function HandHistoryPanel({ roomId }: { roomId: string }) {
  const [hands, setHands] = useState<HandSummaryListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<HandResultShape | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.listHands(roomId);
        setHands(res.hands);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load hand history.");
      }
    })();
  }, [roomId]);

  async function openHand(handNumber: number) {
    setBusy(true);
    setError(null);
    setSelected(handNumber);
    try {
      const res = await api.getHand(roomId, handNumber);
      setDetail((res.summary as HandResultShape) ?? null);
    } catch (e) {
      setDetail(null);
      setError(e instanceof Error ? e.message : "Could not load hand.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel hand-history">
      <strong>Hand history</strong>
      <p className="muted" style={{ marginTop: 0 }}>
        Archived showdowns from this table (play-money chips only).
      </p>
      {error ? (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
      {hands.length === 0 ? (
        <p className="muted">No archived hands yet. Finish a hand to see it here.</p>
      ) : (
        <ul className="hand-history-list">
          {hands.map((h) => {
            const summary = h.summary as HandResultShape;
            const winnerCount = summary?.winners?.length ?? 0;
            return (
              <li key={h.id}>
                <button
                  type="button"
                  className={
                    selected === h.handNumber ? "btn btn-primary" : "btn btn-secondary"
                  }
                  onClick={() => void openHand(h.handNumber)}
                >
                  Hand #{h.handNumber}
                  {winnerCount
                    ? ` · ${winnerCount} winner${winnerCount > 1 ? "s" : ""}`
                    : ""}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {busy ? <p className="muted">Loading replay…</p> : null}
      {detail && selected != null ? (
        <div className="hand-replay" aria-live="polite">
          <h3 style={{ marginBottom: "0.35rem" }}>Replay · Hand #{selected}</h3>
          {(detail.winners ?? []).map((w, i) => (
            <div key={`${w.playerId}-${i}`} className="hand-replay-winner">
              <div>
                Winner pot {w.potIndex + 1}: <strong>{w.amount}</strong> chips
                {w.hand?.label ? ` · ${w.hand.label}` : ""}
              </div>
              {w.hand?.bestFive?.length ? (
                <div className="hand-replay-cards">
                  {w.hand.bestFive.map((c, ci) => (
                    <PlayingCard key={`${c}-${ci}`} code={c} size="hole" />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          {(detail.shownHands ?? []).length > 0 ? (
            <div style={{ marginTop: "0.75rem" }}>
              <div className="muted">Shown hands</div>
              {detail.shownHands!.map((h) => (
                <div
                  key={h.playerId}
                  className="hand-replay-cards"
                  style={{ marginTop: 4 }}
                >
                  {h.cards.map((c, i) => (
                    <PlayingCard key={`${c}-${i}`} code={c} size="hole" />
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
