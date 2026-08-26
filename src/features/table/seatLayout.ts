import type { CSSProperties } from "react";

/**
 * Map a logical seatIndex onto a ring position so `anchorSeatIndex` lands at
 * visual index 0 (bottom / 6 o'clock). Clockwise from there.
 */
export function visualSeatIndex(
  seatIndex: number,
  seatCount: number,
  anchorSeatIndex: number,
): number {
  const n = Math.max(seatCount, 1);
  return ((seatIndex - anchorSeatIndex) % n + n) % n;
}

/** Ellipse percents of the felt (same geometry as `seatRingStyle`). */
export function seatRingPercents(
  visualIndex: number,
  seatCount: number,
): { left: number; top: number } {
  const n = Math.max(seatCount, 1);
  const angle = Math.PI / 2 + (visualIndex * 2 * Math.PI) / n;
  const rx = 42;
  const ry = 38;
  return {
    left: 50 + rx * Math.cos(angle),
    top: 50 + ry * Math.sin(angle),
  };
}

/**
 * Ellipse position as percentages of the felt. Visual index 0 is bottom
 * (sin = +1 in CSS y-down coords); higher indices walk clockwise.
 */
export function seatRingStyle(visualIndex: number, seatCount: number): CSSProperties {
  const { left, top } = seatRingPercents(visualIndex, seatCount);
  return {
    left: `${left}%`,
    top: `${top}%`,
  };
}

/** Deal order: clockwise from the seat after the dealer (like a real button). */
export function dealOrderSeatIndexes(
  dealerSeat: number,
  seatedIndexes: number[],
  seatCount: number,
): number[] {
  const n = Math.max(seatCount, 1);
  const set = new Set(seatedIndexes);
  const ordered: number[] = [];
  for (let i = 1; i <= n; i++) {
    const idx = (dealerSeat + i) % n;
    if (set.has(idx)) ordered.push(idx);
  }
  return ordered;
}
