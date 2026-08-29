# Architecture

- **Client:** React SPA/PWA (Vite) with branded UI, username/password + optional GitHub/Google OAuth, room table, chat, optional RealtimeKit voice.
- **Worker:** Single entry serves Static Assets + `/api/*` + `/ws/*`.
- **RoomDurableObject:** One SQLite DO per room — authoritative engine, hibernatable WebSockets, alarms for turn timers, text chat. Reconnect is **snapshot-only** (projected view + `sequence`); unused `room_events` path removed.
- **D1:** Users (username + email + password hash), OAuth account links, sessions, rooms, membership, join requests, hand summaries, idempotency keys.
- **KV (`CONFIG_KV`):** Non-authoritative flags/copy (`copy:*`, `flag:*`) for `/api/config`.
- **R2 + Queues:** Async hand archival / replay JSON.
- **Analytics Engine:** Aggregate events without PII.
- **Rate limits:** Registration, login, guest join, OAuth start/callback, and join abuse paths.
- **Cron (staging/production):** `0 */6 * * *` runs `purgeExpiredSessions` (expired sessions + revoked older than 7 days).
- **Origin validation:** For `POST /api/*` and `/ws/rooms/:id` upgrades, if the browser sends an `Origin` header it must match `APP_ORIGIN`. Missing `Origin` is allowed (curl, CI scripts). See `worker/lib/origin.ts`.

### Auth (password + OAuth)

- **Register** (`POST /api/auth/register`): username, email, password (+ optional displayName). Email is stored normalized (trim + lowercase) with a unique index.
- **Login** (`POST /api/auth/login`): username + password. PBKDF2 hashes use 100k iterations (fits Workers CPU budgets; 300k previously aborted as generic login/register failures); successful login transparently rehashes when stored iters are lower.
- **OAuth** (`GET /api/auth/oauth/{github|google}` → provider → `/callback`): authorization-code flow with HMAC-signed state. Creates a full (non-guest) user or links by provider subject / verified email. Requires matching `*_CLIENT_ID` + `*_CLIENT_SECRET` secrets; `/api/config` exposes which providers are enabled.
- **Password reset** (`POST /api/auth/reset-password`): **disabled** (account-takeover risk without SMTP). Logged-in users change passwords via `POST /api/auth/change-password` (current + new password); sibling sessions are revoked and a fresh session cookie is issued.
- **Guest join** (`POST /api/rooms/join-as-guest`): creates a guest session and join request in one call.

Privacy: `projectForPlayer` strips foreign hole cards. Voice failure never blocks game actions.
