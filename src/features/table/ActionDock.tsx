import { useEffect, useMemo, useState } from "react";

export interface LegalActionsView {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  callIsAllIn?: boolean;
  canBet: boolean;
  canRaise: boolean;
  minBet: number;
  maxBet: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  canAllIn: boolean;
  allInAmount?: number;
}

export interface ActionDockProps {
  legal: LegalActionsView;
  pot: number;
  sequence: number | undefined;
  disabled: boolean;
  onSend: (payload: unknown) => void;
  /** Controlled raise/bet target; falls back to internal state from legal mins. */
  raiseTo?: number;
  onRaiseToChange?: (value: number) => void;
  className?: string;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function withinRaiseRange(amount: number, min: number, max: number): boolean {
  return amount >= min && amount <= max && Number.isFinite(amount);
}

/**
 * Sticky bottom action dock for mobile (~720px). Uses server legalActions only.
 */
export function ActionDock({
  legal,
  pot,
  sequence,
  disabled,
  onSend,
  raiseTo: raiseToProp,
  onRaiseToChange,
  className = "",
}: ActionDockProps) {
  const minTo = legal.canBet ? legal.minBet : legal.minRaiseTo;
  const maxTo = legal.canBet ? legal.maxBet : legal.maxRaiseTo;
  const canSize = legal.canBet || legal.canRaise;

  const [internalRaiseTo, setInternalRaiseTo] = useState(minTo || 0);
  const raiseTo = raiseToProp ?? internalRaiseTo;
  const setRaiseTo = (v: number) => {
    onRaiseToChange?.(v);
    if (raiseToProp === undefined) setInternalRaiseTo(v);
  };

  useEffect(() => {
    const next = legal.minRaiseTo || legal.minBet || 0;
    if (raiseToProp === undefined) setInternalRaiseTo(next);
    else onRaiseToChange?.(next);
    // Sync only when server mins change; ignore controlled value churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [legal.minRaiseTo, legal.minBet]);

  const sendAction = (action: string, amount?: number) => {
    if (disabled) return;
    onSend({
      type: "action",
      action,
      ...(amount !== undefined ? { amount } : {}),
      expectedVersion: sequence,
      idempotencyKey: crypto.randomUUID(),
    });
  };

  const presets = useMemo(() => {
    if (!canSize) return [];
    // Preset amounts are absolute bet / raise-to values; only show if legal.
    const candidates: Array<{ label: string; amount: number }> = [
      { label: "½ Pot", amount: Math.floor(pot / 2) },
      { label: "Pot", amount: pot },
      { label: "2× Pot", amount: pot * 2 },
      { label: "All-in", amount: maxTo },
    ];
    return candidates.filter((c) => withinRaiseRange(c.amount, minTo, maxTo));
  }, [canSize, pot, minTo, maxTo]);

  const callLabel = legal.callIsAllIn
    ? `ALL-IN ${legal.callAmount}`
    : `CALL ${legal.callAmount}`;

  return (
    <div
      className={`action-dock ${className}`.trim()}
      aria-label="Your actions"
      data-disabled={disabled ? "true" : undefined}
    >
      <div className="action-dock__meta">
        To call {legal.canCall ? legal.callAmount : 0} · Pot {pot}
      </div>

      <div className="action-dock__primary">
        {legal.canFold ? (
          <button
            className="btn btn-danger action-dock__btn"
            type="button"
            disabled={disabled}
            onClick={() => sendAction("fold")}
          >
            FOLD
          </button>
        ) : null}
        {legal.canCheck ? (
          <button
            className="btn btn-secondary action-dock__btn"
            type="button"
            disabled={disabled}
            onClick={() => sendAction("check")}
          >
            CHECK
          </button>
        ) : null}
        {legal.canCall ? (
          <button
            className="btn btn-secondary action-dock__btn"
            type="button"
            disabled={disabled}
            onClick={() => sendAction("call")}
          >
            {callLabel}
          </button>
        ) : null}
        {canSize ? (
          <button
            className="btn btn-primary action-dock__btn"
            type="button"
            disabled={disabled || !withinRaiseRange(raiseTo, minTo, maxTo)}
            onClick={() => sendAction(legal.canBet ? "bet" : "raise", raiseTo)}
          >
            {legal.canBet ? "BET" : "RAISE"} {raiseTo}
          </button>
        ) : null}
        {legal.canAllIn ? (
          <button
            className="btn btn-secondary action-dock__btn"
            type="button"
            disabled={disabled}
            onClick={() => sendAction("all_in")}
          >
            ALL-IN
          </button>
        ) : null}
      </div>

      {canSize ? (
        <div className="action-dock__sizing">
          <label className="sr-only" htmlFor="action-dock-raise">
            {legal.canBet ? "Bet amount" : "Raise to"}
          </label>
          <input
            id="action-dock-raise"
            className="action-dock__input"
            type="number"
            min={minTo}
            max={maxTo}
            value={raiseTo}
            disabled={disabled}
            onChange={(e) => setRaiseTo(clamp(Number(e.target.value), minTo, maxTo))}
          />
          {presets.length > 0 ? (
            <div className="action-dock__presets" role="group" aria-label="Bet size presets">
              {presets.map((p) => (
                <button
                  key={p.label}
                  className="btn btn-secondary action-dock__preset"
                  type="button"
                  disabled={disabled}
                  onClick={() => setRaiseTo(p.amount)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
