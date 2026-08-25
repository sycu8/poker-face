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

/**
 * Ellipse position as percentages of the felt. Visual index 0 is bottom
 * (sin = +1 in CSS y-down coords); higher indices walk clockwise.
 */
export function seatRingStyle(visualIndex: number, seatCount: number): CSSProperties {
  const n = Math.max(seatCount, 1);
  const angle = Math.PI / 2 + (visualIndex * 2 * Math.PI) / n;
  const rx = 44;
  const ry = 42;
  const left = 50 + rx * Math.cos(angle);
  const top = 50 + ry * Math.sin(angle);
  return {
    left: `${left}%`,
    top: `${top}%`,
  };
}
