# Architecture

- **Client:** React SPA/PWA (Vite) with branded UI, username/password + optional GitHub/Google OAuth, room table, chat, optional RealtimeKit voice.
- **Worker:** Single entry serves Static Assets + `/api/*` + `/ws/*` + public agent-discovery documents. `assets.run_worker_first` is true so those routes are not rewritten to `index.html`.
- **RoomDurableObject:** One SQLite DO per room — authoritative engine, hibernatable WebSockets, alarms for turn timers, text chat. Reconnect is **snapshot-only** (projected view + `sequence`); unused `room_events` path removed.
- **D1:** Users (username + email + password hash), OAuth account links, sessions, rooms, membership, join requests, hand summaries, idempotency keys.
- **KV (`CONFIG_KV`):** Non-authoritative flags/copy (`copy:*`, `flag:*`) for `/api/config`.
- **R2 + Queues:** Async hand archival / replay JSON.
- **Analytics Engine:** Aggregate events without PII.
- **Rate limits:** Registration, login, guest join, OAuth start/callback, and join abuse paths.
- **Turnstile:** Managed widget on login/register/guest/join; Worker siteverify requires `success`, matching `action`, and hostname in `TURNSTILE_HOSTNAMES` (or `APP_ORIGIN` host).
- **Cron (staging/production):** `0 */6 * * *` runs `purgeExpiredSessions` (expired sessions + revoked older than 7 days).
- **Origin validation:** For `POST /api/*` and `/ws/rooms/:id` upgrades, if the browser sends an `Origin` header it must match `APP_ORIGIN`. Missing `Origin` is allowed (curl, CI scripts). See `worker/lib/origin.ts`.

### Auth (password + OAuth)

- **Register** (`POST /api/auth/register`): username, email, password (+ optional displayName). Email is stored normalized (trim + lowercase) with a unique index.
- **Login** (`POST /api/auth/login`): username + password. PBKDF2 hashes use 100k iterations (fits Workers CPU budgets; 300k previously aborted as generic login/register failures); successful login transparently rehashes when stored iters are lower.
- **OAuth** (`GET /api/auth/oauth/{github|google}` → provider → `/callback`): authorization-code flow with HMAC-signed state. Creates a full (non-guest) user or links by provider subject / verified email. Requires matching `*_CLIENT_ID` + `*_CLIENT_SECRET` secrets; `/api/config` exposes which providers are enabled.
- **Turnstile** on password/guest/join POSTs: client sends `turnstileToken`; Worker verifies via `https://challenges.cloudflare.com/turnstile/v0/siteverify` before the existing handler runs.
- **Password reset** (`POST /api/auth/reset-password`): **disabled** (account-takeover risk without SMTP). Logged-in users change passwords via `POST /api/auth/change-password` (current + new password); sibling sessions are revoked and a fresh session cookie is issued.
- **Guest join** (`POST /api/rooms/join-as-guest`): creates a guest session and join request in one call.

Privacy: `projectForPlayer` strips foreign hole cards. Voice failure never blocks game actions.

### Agent discovery

The Worker publishes the public discovery surface from `worker/discovery/`:

- `/robots.txt` allows search crawlers on public pages and disallows training crawlers. Private tables, `/api/`, `/ws/`, `/admin`, and `/mcp` stay closed. Content Signals set `ai-train=no`, `search=yes`, `ai-input=no` for search and the default agent.
- `/sitemap.xml` lists `/` and `/auth`.
- `/.well-known/api-catalog`, `/openapi.json`, `/auth.md`, OAuth/OIDC metadata, the MCP server card, the agent-skills index, and `/.well-known/ai-catalog.json`.
- Homepage responses include RFC 8288 `Link` headers. The browser registers WebMCP tools on load.
- Protected API `401` responses include `WWW-Authenticate` with `resource_metadata`.

Sessions remain the HttpOnly `pf_session` cookie. `POST /oauth/token` does not issue bearer tokens.

DNS for AI Discovery records live in `dns/dnsaid.zone`. Publish them on the public zone for `poker.orangecloud.vn` (and staging), then enable DNSSEC at the registrar so validating resolvers can authenticate the `_agents` names. The Worker cannot sign DNS.
