import { describe, expect, it } from "vitest";
import {
  BoundedIdempotencyCache,
  ChatRateLimiter,
  parseWsClientMessage,
  WS_MAX_MESSAGE_BYTES,
} from "../../worker/room/wsProtocol";

describe("wsProtocol", () => {
  it("accepts a valid action message", () => {
    const raw = JSON.stringify({
      type: "action",
      action: "call",
      expectedVersion: 3,
      idempotencyKey: "abcdefgh",
    });
    const parsed = parseWsClientMessage(raw);
    expect(parsed.ok).toBe(true);
  });

  it("rejects unknown message types", () => {
    const parsed = parseWsClientMessage(JSON.stringify({ type: "hack" }));
    expect(parsed.ok).toBe(false);
  });

  it("rejects malformed JSON", () => {
    const parsed = parseWsClientMessage("{nope");
    expect(parsed.ok).toBe(false);
  });

  it("rejects oversized payloads", () => {
    const huge = "x".repeat(WS_MAX_MESSAGE_BYTES + 10);
    const parsed = parseWsClientMessage(huge);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.close).toBe(true);
  });

  it("rejects UTF-8 oversized payloads when character count is under the limit", () => {
    // Each 😀 is 4 UTF-8 bytes. 2100 emoji = 8400 bytes > 8192, but length=2100.
    const emoji = "😀".repeat(2100);
    expect(emoji.length).toBeLessThan(WS_MAX_MESSAGE_BYTES);
    expect(new TextEncoder().encode(emoji).byteLength).toBeGreaterThan(
      WS_MAX_MESSAGE_BYTES,
    );
    const parsed = parseWsClientMessage(emoji);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.close).toBe(true);
  });

  it("rejects unknown fields (strict schemas)", () => {
    const parsed = parseWsClientMessage(JSON.stringify({ type: "ping", hack: true }));
    expect(parsed.ok).toBe(false);
  });

  it("rejects NaN / Infinity amounts", () => {
    const parsed = parseWsClientMessage(
      JSON.stringify({
        type: "action",
        action: "raise",
        amount: Number.POSITIVE_INFINITY,
        expectedVersion: 1,
        idempotencyKey: "abcdefgh",
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("requires expectedVersion and idempotencyKey on actions", () => {
    const parsed = parseWsClientMessage(
      JSON.stringify({ type: "action", action: "fold" }),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe("BoundedIdempotencyCache", () => {
  it("detects same key different payload via hash storage", () => {
    const cache = new BoundedIdempotencyCache(2);
    cache.set("k1", "aaa", 1);
    expect(cache.get("k1")?.payloadHash).toBe("aaa");
    cache.set("k2", "bbb", 1);
    cache.set("k3", "ccc", 1);
    expect(cache.get("k1")).toBeUndefined();
  });
});

describe("ChatRateLimiter", () => {
  it("rate limits burst then recovers", () => {
    const lim = new ChatRateLimiter(1, 3);
    const t0 = 1_000_000;
    expect(lim.allow("u", t0)).toBe(true);
    expect(lim.allow("u", t0)).toBe(true);
    expect(lim.allow("u", t0)).toBe(true);
    expect(lim.allow("u", t0)).toBe(false);
    expect(lim.allow("u", t0 + 5_000)).toBe(true);
  });
});
