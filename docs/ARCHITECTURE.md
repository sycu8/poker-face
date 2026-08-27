# Architecture

- **Client:** React SPA/PWA (Vite) with branded UI, username/password auth, room table, chat, optional RealtimeKit voice.
- **Worker:** Single entry serves Static Assets + `/api/*` + `/ws/*`.
- **RoomDurableObject:** One SQLite DO per room — authoritative engine, hibernatable WebSockets, alarms for turn timers, text chat. Reconnect is **snapshot-only** (projected view + `sequence`); unused `room_events` path removed.
- **D1:** Users (username + email + password hash), sessions, rooms, membership, join requests, hand summaries, idempotency keys.
- **KV (`CONFIG_KV`):** Non-authoritative flags/copy (`copy:*`, `flag:*`) for `/api/config`.
- **R2 + Queues:** Async hand archival / replay JSON.
- **Analytics Engine:** Aggregate events without PII.
- **Rate limits + Turnstile:** Registration, login, guest join, and join abuse paths.
- **Cron (staging/production):** `0 */6 * * *` runs `purgeExpiredSessions` (expired sessions + revoked older than 7 days).

### Auth (password)

- **Register** (`POST /api/auth/register`): username, email, password (+ optional displayName / Turnstile). Email is stored normalized (trim + lowercase) with a unique index.
- **Login** (`POST /api/auth/login`): username + password. PBKDF2 hashes use 300k iterations (Workers-compatible middle ground); successful login transparently rehashes when stored iters are lower.
- **Password reset** (`POST /api/auth/reset-password`): **disabled** (account-takeover risk without SMTP). Logged-in users change passwords via `POST /api/auth/change-password` (current + new password); sibling sessions are revoked and a fresh session cookie is issued.
- **Guest join** (`POST /api/rooms/join-as-guest`): creates a guest session and join request in one call (Turnstile verified once).

Privacy: `projectForPlayer` strips foreign hole cards. Voice failure never blocks game actions.
