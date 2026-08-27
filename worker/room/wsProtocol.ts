import { z } from "zod";

/** Max WebSocket client payload (~8 KiB). */
export const WS_MAX_MESSAGE_BYTES = 8 * 1024;

const finiteNumber = z.number().finite();
const nonNegInt = z.number().finite().int().nonnegative().max(1_000_000_000);

export const wsActionTypeSchema = z.enum([
  "fold",
  "check",
  "call",
  "bet",
  "raise",
  "all_in",
]);

export const wsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("chat"),
    text: z.string().max(280),
  }),
  z.object({
    type: z.literal("pause"),
    paused: z.boolean(),
  }),
  z.object({ type: z.literal("rabbit") }),
  z.object({ type: z.literal("request_start") }),
  z.object({ type: z.literal("start_hand") }),
  z.object({
    type: z.literal("action"),
    action: wsActionTypeSchema,
    amount: finiteNumber.optional(),
    expectedVersion: nonNegInt,
    idempotencyKey: z.string().trim().min(8).max(128),
  }),
]);

export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

export function parseWsClientMessage(
  raw: string | ArrayBuffer,
): { ok: true; data: WsClientMessage } | { ok: false; error: string; close?: boolean } {
  if (typeof raw !== "string") {
    if (raw.byteLength > WS_MAX_MESSAGE_BYTES) {
      return { ok: false, error: "Message too large.", close: true };
    }
    try {
      raw = new TextDecoder().decode(raw);
    } catch {
      return { ok: false, error: "Invalid message encoding." };
    }
  }
  if (raw.length > WS_MAX_MESSAGE_BYTES) {
    return { ok: false, error: "Message too large.", close: true };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON." };
  }
  const parsed = wsClientMessageSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue
        ? `Invalid message: ${issue.path.join(".") || "body"}`
        : "Invalid message.",
    };
  }
  if (parsed.data.type === "action" && parsed.data.amount !== undefined) {
    if (!Number.isFinite(parsed.data.amount) || Number.isNaN(parsed.data.amount)) {
      return { ok: false, error: "Invalid amount." };
    }
  }
  return { ok: true, data: parsed.data };
}

/** Bound in-memory action idempotency (per-hand + LRU-ish). */
export class BoundedIdempotencyCache {
  private map = new Map<string, { payloadHash: string; handNumber: number }>();
  constructor(private readonly maxEntries = 256) {}

  get(key: string): { payloadHash: string; handNumber: number } | undefined {
    return this.map.get(key);
  }

  set(key: string, payloadHash: string, handNumber: number): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { payloadHash, handNumber });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Drop entries from completed hands older than keepHand. */
  pruneBeforeHand(keepHand: number): void {
    for (const [k, v] of this.map) {
      if (v.handNumber < keepHand - 2) this.map.delete(k);
    }
  }
}

/** Simple token-bucket chat rate limit (per user, in-memory). */
export class ChatRateLimiter {
  private buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly ratePerSec = 5 / 5, // 5 messages / 5 seconds
    private readonly burst = 10,
  ) {}

  allow(userId: string, nowMs: number): boolean {
    const bucket = this.buckets.get(userId) ?? {
      tokens: this.burst,
      updatedAt: nowMs,
    };
    const elapsed = Math.max(0, (nowMs - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.ratePerSec);
    bucket.updatedAt = nowMs;
    if (bucket.tokens < 1) {
      this.buckets.set(userId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(userId, bucket);
    // Bound map size
    if (this.buckets.size > 200) {
      const first = this.buckets.keys().next().value;
      if (first) this.buckets.delete(first);
    }
    return true;
  }
}

export async function hashActionPayload(payload: {
  action: string;
  amount?: number;
  expectedVersion: number;
}): Promise<string> {
  const data = new TextEncoder().encode(
    JSON.stringify({
      action: payload.action,
      amount: payload.amount ?? null,
      expectedVersion: payload.expectedVersion,
    }),
  );
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
