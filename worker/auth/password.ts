/** Password hashing with Web Crypto PBKDF2 (Workers-compatible). */

/**
 * PBKDF2 iteration count. 300k is a Workers-compatible middle ground:
 * stronger than the prior 100k default while staying within typical
 * isolate CPU budgets for auth request paths.
 */
export const PBKDF2_ITERS = 300_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** True when a stored hash uses fewer iterations than the current target. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return true;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations)) return true;
  return iterations < PBKDF2_ITERS;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERS,
      hash: "SHA-256",
    },
    keyMaterial,
    KEY_BITS,
  );
  return `pbkdf2$${PBKDF2_ITERS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(derived))}`;
}

/** Fixed dummy hash so unknown-user login still pays PBKDF2 cost (timing). */
const DUMMY_PASSWORD_HASH =
  "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** Run verify work even when no user row exists (mitigate timing oracles). */
export async function verifyPasswordOrDummy(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return false;
  }
  return verifyPassword(password, stored);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 50_000 || iterations > 1_000_000) {
    return false;
  }
  const salt = base64ToBytes(parts[2]);
  const expected = base64ToBytes(parts[3]);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      expected.byteLength * 8,
    ),
  );
  if (derived.byteLength !== expected.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < derived.byteLength; i++) diff |= derived[i]! ^ expected[i]!;
  return diff === 0;
}
