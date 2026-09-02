#!/usr/bin/env node
/**
 * Local admin API smoke test.
 * Registers a user, promotes to super_admin, seeds rooms, exercises /api/admin/stats.
 *
 * Usage:
 *   node scripts/admin-smoke.mjs [baseUrl]
 * Default baseUrl: http://127.0.0.1:8787
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const USERNAME = `adm${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const PASSWORD = "admin-test-pass-123";
const EMAIL = `${USERNAME}@example.test`;

async function parse(res) {
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function d1(sql) {
  execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--command", sql], {
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
}

async function main() {
  const registerRes = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: USERNAME,
      email: EMAIL,
      password: PASSWORD,
      displayName: "Admin Smoke",
    }),
  });
  const registered = await parse(registerRes);
  const userId = registered.user.id;

  d1(`UPDATE users SET role = 'super_admin' WHERE id = '${userId}';`);

  const now = Date.now();
  const fiveDaysAgo = now - 5 * 24 * 60 * 60 * 1000;
  const roomOld = `room_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const roomNew = `room_${randomUUID().replaceAll("-", "").slice(0, 8)}`;

  d1(`
    INSERT INTO rooms (id, host_user_id, name, invite_code, small_blind, big_blind, starting_stack, pot_cap_multiplier, status, created_at, updated_at)
    VALUES
      ('${roomOld}', '${userId}', 'Old Room', 'OLDSMK', 10, 20, 1000, 2, 'closed', ${fiveDaysAgo - 86400000}, ${fiveDaysAgo}),
      ('${roomNew}', '${userId}', 'Active Room', 'NEWMSK', 10, 20, 1000, 2, 'open', ${now - 3600000}, ${now});

    INSERT INTO room_members (room_id, user_id, role, seat_index, display_name, status, created_at, updated_at)
    VALUES ('${roomNew}', '${userId}', 'host', 0, 'Admin Smoke', 'seated', ${now}, ${now});

    INSERT INTO hand_summaries (id, room_id, hand_number, sequence_end, summary_json, created_at)
    VALUES ('hand_${randomUUID().replaceAll("-", "").slice(0, 8)}', '${roomNew}', 1, 10, '{}', ${now - 1800000});
  `);

  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const login = await parse(loginRes);
  const cookie = loginRes.headers.getSetCookie?.()?.[0]?.split(";")[0];
  if (!cookie) throw new Error("Missing session cookie from login");
  if (login.user.role !== "super_admin") throw new Error("Expected super_admin role");

  const statsRes = await fetch(`${BASE}/api/admin/stats?days=5`, {
    headers: { cookie },
  });
  const stats = await parse(statsRes);

  const forbidden = await fetch(`${BASE}/api/admin/stats?days=5`);
  if (forbidden.status !== 401) {
    throw new Error(`Expected 401 without session, got ${forbidden.status}`);
  }

  if (stats.rooms.total < 2) throw new Error("Expected at least 2 seeded rooms");
  if (stats.rooms.activeInPeriod < 1) throw new Error("Expected active room in period");

  console.log("admin-smoke ok", JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
