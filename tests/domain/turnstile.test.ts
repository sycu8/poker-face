import { describe, expect, it, vi, afterEach } from "vitest";
import { verifyTurnstile } from "../../worker/lib/turnstile";
import type { Env } from "../../worker/env";

function envStub(partial: Partial<Env>): Env {
  return partial as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyTurnstile", () => {
  it("fails closed in production when secret is missing", async () => {
    await expect(
      verifyTurnstile(envStub({ ENVIRONMENT: "production" }), "token", null),
    ).resolves.toBe(false);
  });

  it("fails open in local when secret is missing", async () => {
    await expect(
      verifyTurnstile(envStub({ ENVIRONMENT: "local" }), undefined, null),
    ).resolves.toBe(true);
  });

  it("fails open in development when secret is missing", async () => {
    await expect(
      verifyTurnstile(envStub({ ENVIRONMENT: "development" }), undefined, null),
    ).resolves.toBe(true);
  });

  it("rejects missing token when secret is set", async () => {
    await expect(
      verifyTurnstile(
        envStub({ ENVIRONMENT: "production", TURNSTILE_SECRET_KEY: "sec" }),
        undefined,
        null,
      ),
    ).resolves.toBe(false);
  });

  it("calls siteverify when secret and token are present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: true, hostname: "poker.example.com" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      verifyTurnstile(
        envStub({
          ENVIRONMENT: "production",
          TURNSTILE_SECRET_KEY: "sec",
          APP_ORIGIN: "https://poker.example.com",
        }),
        "tok",
        "1.2.3.4",
      ),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeDefined();
  });

  it("rejects when hostname does not match APP_ORIGIN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ success: true, hostname: "evil.example" }),
      }),
    );
    await expect(
      verifyTurnstile(
        envStub({
          ENVIRONMENT: "production",
          TURNSTILE_SECRET_KEY: "sec",
          APP_ORIGIN: "https://poker.example.com",
        }),
        "tok",
        null,
      ),
    ).resolves.toBe(false);
  });

  it("rejects when expectedAction does not match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          success: true,
          hostname: "poker.example.com",
          action: "login",
        }),
      }),
    );
    await expect(
      verifyTurnstile(
        envStub({
          ENVIRONMENT: "production",
          TURNSTILE_SECRET_KEY: "sec",
          APP_ORIGIN: "https://poker.example.com",
        }),
        "tok",
        null,
        "join",
      ),
    ).resolves.toBe(false);
  });

  it("accepts matching expectedAction", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          success: true,
          hostname: "poker.example.com",
          action: "join",
        }),
      }),
    );
    await expect(
      verifyTurnstile(
        envStub({
          ENVIRONMENT: "production",
          TURNSTILE_SECRET_KEY: "sec",
          APP_ORIGIN: "https://poker.example.com",
        }),
        "tok",
        null,
        "join",
      ),
    ).resolves.toBe(true);
  });

  it("rejects oversized tokens", async () => {
    await expect(
      verifyTurnstile(
        envStub({ ENVIRONMENT: "production", TURNSTILE_SECRET_KEY: "sec" }),
        "x".repeat(2049),
        null,
      ),
    ).resolves.toBe(false);
  });

  it("fails closed on siteverify timeout/network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError")),
    );
    await expect(
      verifyTurnstile(
        envStub({ ENVIRONMENT: "production", TURNSTILE_SECRET_KEY: "sec" }),
        "tok",
        null,
      ),
    ).resolves.toBe(false);
  });
});
