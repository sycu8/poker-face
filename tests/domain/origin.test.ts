import { describe, expect, it } from "vitest";
import { rejectDisallowedOrigin, requiresOriginCheck } from "../../worker/lib/origin";

describe("origin validation", () => {
  it("allows missing Origin", () => {
    const req = new Request("https://poker.example.com/api/rooms", { method: "POST" });
    expect(rejectDisallowedOrigin(req, "https://poker.example.com")).toBeNull();
  });

  it("allows matching Origin", () => {
    const req = new Request("https://poker.example.com/ws/rooms/room_1", {
      method: "GET",
      headers: { Origin: "https://poker.example.com" },
    });
    expect(rejectDisallowedOrigin(req, "https://poker.example.com")).toBeNull();
  });

  it("rejects mismatched Origin", async () => {
    const req = new Request("https://poker.example.com/api/auth/login", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    const res = rejectDisallowedOrigin(req, "https://poker.example.com");
    expect(res?.status).toBe(403);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain("Origin");
  });

  it("flags ws and post api paths", () => {
    expect(
      requiresOriginCheck(
        new Request("https://x/ws/rooms/r1", { method: "GET" }),
        "/ws/rooms/r1",
      ),
    ).toBe(true);
    expect(
      requiresOriginCheck(
        new Request("https://x/api/rooms", { method: "POST" }),
        "/api/rooms",
      ),
    ).toBe(true);
    expect(
      requiresOriginCheck(
        new Request("https://x/api/health", { method: "GET" }),
        "/api/health",
      ),
    ).toBe(false);
  });
});
