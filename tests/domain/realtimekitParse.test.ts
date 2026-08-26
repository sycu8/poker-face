import { describe, expect, it } from "vitest";
import { extractRealtimeId, extractRealtimeToken } from "../../worker/voice/realtimekit";

describe("RealtimeKit response parsing", () => {
  it("extracts meeting id from Cloudflare result envelope", () => {
    expect(extractRealtimeId({ success: true, result: { id: "mtg_abc" } })).toBe("mtg_abc");
  });

  it("extracts meeting id from nested data envelopes", () => {
    expect(extractRealtimeId({ success: true, result: { data: { id: "mtg_nested" } } })).toBe(
      "mtg_nested",
    );
    expect(extractRealtimeId({ success: true, data: { id: "mtg_top_data" } })).toBe("mtg_top_data");
  });

  it("extracts participant token from common shapes", () => {
    expect(extractRealtimeToken({ result: { token: "tok_a" } })).toBe("tok_a");
    expect(extractRealtimeToken({ result: { data: { authToken: "tok_b" } } })).toBe("tok_b");
    expect(extractRealtimeToken({ data: { token: "tok_c" } })).toBe("tok_c");
  });
});
