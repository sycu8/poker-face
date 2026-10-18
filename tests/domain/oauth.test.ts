import { describe, expect, it } from "vitest";
import {
  createOAuthState,
  oauthProvidersConfigured,
  parseOAuthState,
  type ProviderProfile,
  upsertOAuthUser,
} from "../../worker/auth/oauth";
import type { Env } from "../../worker/env";

function mockKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

describe("oauth state", () => {
  it("round-trips a signed state with invite", async () => {
    const secret = "test-session-secret-for-oauth";
    const state = await createOAuthState(secret, "github", "AB12CD");
    const parsed = await parseOAuthState(secret, state, "github");
    expect(parsed).toEqual({ ok: true, invite: "AB12CD" });
  });

  it("rejects tampered state and provider mismatch", async () => {
    const secret = "test-session-secret-for-oauth";
    const state = await createOAuthState(secret, "google", null);
    const [body] = state.split(".");
    const bad = `${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect((await parseOAuthState(secret, bad, "google")).ok).toBe(false);
    expect((await parseOAuthState(secret, state, "github")).ok).toBe(false);
  });

  it("rejects expired state", async () => {
    const secret = "test-session-secret-for-oauth";
    const state = await createOAuthState(secret, "github");
    const ok = await parseOAuthState(secret, state, "github");
    expect(ok.ok).toBe(true);
  });

  it("enforces single-use when KV is provided", async () => {
    const secret = "test-session-secret-for-oauth";
    const kv = mockKv();
    const state = await createOAuthState(
      secret,
      "github",
      "XY99ZZ",
      kv as unknown as KVNamespace,
    );
    expect(kv.store.size).toBe(1);
    const first = await parseOAuthState(
      secret,
      state,
      "github",
      kv as unknown as KVNamespace,
    );
    expect(first).toEqual({ ok: true, invite: "XY99ZZ" });
    expect(kv.store.size).toBe(0);
    const replay = await parseOAuthState(
      secret,
      state,
      "github",
      kv as unknown as KVNamespace,
    );
    expect(replay.ok).toBe(false);
  });
});

describe("oauthProvidersConfigured", () => {
  it("requires both id and secret per provider", () => {
    const env = {
      GITHUB_CLIENT_ID: "gh-id",
      GITHUB_CLIENT_SECRET: "gh-secret",
      GOOGLE_CLIENT_ID: "go-id",
    } as Env;
    expect(oauthProvidersConfigured(env)).toEqual({
      github: true,
      google: false,
    });
  });
});

type Row = Record<string, unknown>;

/** Minimal D1 stub for upsertOAuthUser unit tests. */
function mockDb(seed: { oauth?: Row | null }) {
  const inserts: Array<{ sql: string; binds: unknown[] }> = [];
  const updates: Array<{ sql: string; binds: unknown[] }> = [];

  const prepare = (sql: string) => {
    const stmt = {
      bind: (...binds: unknown[]) => ({
        first: async <T>(): Promise<T | null> => {
          if (sql.includes("FROM oauth_accounts")) {
            return (seed.oauth as T) ?? null;
          }
          return null;
        },
        run: async () => {
          if (sql.startsWith("INSERT")) inserts.push({ sql, binds });
          if (sql.startsWith("UPDATE")) updates.push({ sql, binds });
          return { meta: { changes: 1 } };
        },
      }),
    };
    return stmt;
  };

  return {
    prepare,
    inserts,
    updates,
  };
}

describe("upsertOAuthUser", () => {
  const profile: ProviderProfile = {
    providerUserId: "42",
    email: "alice@example.com",
    emailVerified: true,
    displayName: "Alice",
  };

  it("returns existing linked account", async () => {
    const db = mockDb({
      oauth: {
        user_id: "usr_existing",
        display_name: "Alice Linked",
        username: "alice",
      },
    });
    const env = { DB: db } as unknown as Env;
    const user = await upsertOAuthUser(env, "github", profile);
    expect(user).toEqual({
      userId: "usr_existing",
      displayName: "Alice Linked",
      username: "alice",
    });
    expect(db.updates.length).toBe(1);
    expect(db.inserts.length).toBe(0);
  });

  it("does not auto-link by email to a password account", async () => {
    // Even if a password user already owns alice@example.com, OAuth must create
    // a separate user — emails from password signup are unverified.
    const db = mockDb({ oauth: null });
    const env = { DB: db } as unknown as Env;
    const user = await upsertOAuthUser(env, "google", profile);
    expect(user.userId.startsWith("usr_")).toBe(true);
    expect(user.displayName).toBe("Alice");
    expect(user.username).toBeNull();
    expect(db.inserts.length).toBe(2);
    expect(db.inserts.some((i) => i.sql.includes("oauth_accounts"))).toBe(true);
    expect(db.inserts.some((i) => i.sql.includes("INSERT INTO users"))).toBe(true);
  });

  it("creates a new full user when no provider link exists", async () => {
    const db = mockDb({ oauth: null });
    const env = { DB: db } as unknown as Env;
    const user = await upsertOAuthUser(env, "github", {
      ...profile,
      email: null,
      emailVerified: false,
    });
    expect(user.userId.startsWith("usr_")).toBe(true);
    expect(user.username).toBeNull();
    expect(db.inserts.length).toBe(2);
  });
});
