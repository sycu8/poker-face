# Poker Faces

Private play-money Texas Hold'em for friends. **Your table. Your people.**

Deploy target: `https://poker.orangecloud.vn`

Virtual chips only. No purchases, cash-out, wallets, or real-money language.

## Stack

- React SPA/PWA + Vite + `@cloudflare/vite-plugin`
- Single Worker for static assets + HTTP APIs
- SQLite-backed Durable Object per room (hibernatable WebSockets)
- D1 (users, sessions, rooms, hand summaries)
- KV / R2 / Queues / Analytics Engine / Rate Limiting / Turnstile
- Username + password auth (PBKDF2) with cookie sessions
- Host-approved private tables, text chat, optional voice
- PWA manifest + service worker shell cache
- Voice via Cloudflare RealtimeKit (degraded-safe when unset)

## Quick start

```bash
npm install
cp .env.example .dev.vars
# set SESSION_SECRET at minimum
npm run db:migrate:local
npm run dev
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite + Worker local |
| `npm run typecheck` | TypeScript |
| `npm run test` | Vitest (domain + worker) |
| `npm run test:domain` | Poker engine tests |
| `npm run build` | Production build |
| `npm run cf-typegen` | Generate Worker binding types |
| `npm run db:migrate:local` | Apply D1 migrations locally |

## Brand

See `docs/BRAND_GUIDE.md` and `logo/`.

## Game rules

See `docs/GAME_RULES.md`.

## Environments

Keep local, staging, and production resources separate. Fill IDs in `wrangler.jsonc` from created Cloudflare resources; never commit secrets. Use `wrangler.template.jsonc` as the ID-free reference.

**GitHub Actions deploy:** see [`docs/GITHUB_ACTIONS_DEPLOY.md`](docs/GITHUB_ACTIONS_DEPLOY.md). Set `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `SESSION_SECRET`, then run **Deploy Cloudflare** (`all`).

For optional table voice, also set `REALTIMEKIT_APP_ID`, `REALTIMEKIT_API_TOKEN`, and ensure `CLOUDFLARE_ACCOUNT_ID` is uploaded as a Worker secret (the deploy workflow does this). Optionally set `REALTIMEKIT_PRESET_NAME` (default `group_call_participant`).

Production deploy requires an explicit gate report and approval for manual ops; the Actions workflow is the supported path when secrets are configured.
