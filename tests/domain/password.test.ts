import { describe, expect, it } from "vitest";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  needsRehash,
  PBKDF2_ITERS,
  verifyPassword,
  verifyPasswordOrDummy,
} from "../../worker/auth/password";

describe("password hashing", () => {
  it("hashes and verifies a password at current iteration count", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(hash.startsWith(`pbkdf2$${PBKDF2_ITERS}$`)).toBe(true);
    expect(await verifyPassword("correct-horse-battery", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "pbkdf2$100$aa$bb")).toBe(false);
  });

  it("runs dummy work when hash is missing", async () => {
    expect(await verifyPasswordOrDummy("password", null)).toBe(false);
    expect(await verifyPasswordOrDummy("password", undefined)).toBe(false);
    const hash = await hashPassword("password");
    expect(await verifyPasswordOrDummy("password", hash)).toBe(true);
  });

  it("flags older iteration counts for rehash", () => {
    expect(needsRehash("pbkdf2$100000$salt$hash")).toBe(true);
    expect(needsRehash(`pbkdf2$${PBKDF2_ITERS}$salt$hash`)).toBe(false);
    expect(needsRehash("not-a-hash")).toBe(true);
  });

  it("dummy hash iteration count stays aligned with PBKDF2_ITERS", () => {
    expect(DUMMY_PASSWORD_HASH.startsWith(`pbkdf2$${PBKDF2_ITERS}$`)).toBe(true);
    const iters = Number(DUMMY_PASSWORD_HASH.split("$")[1]);
    expect(iters).toBe(PBKDF2_ITERS);
  });

  it("still verifies legacy 100k hashes", async () => {
    // Build a 100k hash manually via crypto (same algorithm as hashPassword).
    const password = "legacy-password";
    const salt = new Uint8Array(16).fill(7);
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const derived = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
        keyMaterial,
        256,
      ),
    );
    const b64 = (bytes: Uint8Array) => {
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary);
    };
    const legacy = `pbkdf2$100000$${b64(salt)}$${b64(derived)}`;
    expect(await verifyPassword(password, legacy)).toBe(true);
    expect(needsRehash(legacy)).toBe(true);
  });
});
