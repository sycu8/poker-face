import { describe, expect, it, vi } from "vitest";
import { verifyTurnstile } from "../../worker/lib/turnstile";
import type { Env } from "../../worker/env";

function envStub(partial: Partial<Env>): Env {
  return partial as Env;
}

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
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      verifyTurnstile(
        envStub({ ENVIRONMENT: "production", TURNSTILE_SECRET_KEY: "sec" }),
        "tok",
        "1.2.3.4",
      ),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
