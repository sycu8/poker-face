import type { Env } from "../env";

/** Best-effort Analytics Engine write — never throws into request paths. */
export function writeAnalytics(
  env: Env,
  event: string,
  index: string,
  doubles: number[] = [],
  blobs: string[] = [],
): void {
  try {
    env.ANALYTICS.writeDataPoint({
      blobs: [event, ...blobs],
      doubles,
      indexes: [index],
    });
  } catch {
    /* analytics optional locally */
  }
}
