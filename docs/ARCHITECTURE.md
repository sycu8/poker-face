# Architecture

- **Client:** React SPA/PWA (Vite) with branded UI, username/password auth, room table, chat, optional RealtimeKit voice.
- **Worker:** Single entry serves Static Assets + `/api/*` + `/ws/*`.
- **RoomDurableObject:** One SQLite DO per room — authoritative engine, hibernatable WebSockets, alarms for turn timers, text chat. Reconnect is **snapshot-only** (projected view + `sequence`); unused `room_events` path removed.
- **D1:** Users (username + email + password hash), sessions, rooms, membership, join requests, hand summaries, idempotency keys.
- **KV (`CONFIG_KV`):** Non-authoritative flags/copy (`copy:*`, `flag:*`) for `/api/config`.
- **R2 + Queues:** Async hand archival / replay JSON.
- **Analytics Engine:** Aggregate events without PII.
- **Rate limits + Turnstile:** Registration, password reset, and join abuse paths.

### Auth (password)

- **Register** (`POST /api/auth/register`): username, email, password (+ optional displayName / Turnstile). Email is stored normalized (trim + lowercase) with a unique index.
- **Login** (`POST /api/auth/login`): username + password.
- **Reset password** (`POST /api/auth/reset-password`): username + email + newPassword. No SMTP — the Worker verifies username and email match the same user, then updates `password_hash` (PBKDF2, 100k iters) and revokes existing sessions. Errors do not distinguish wrong username vs wrong email.

Privacy: `projectForPlayer` strips foreign hole cards. Voice failure never blocks game actions.
