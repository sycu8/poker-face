# Poker Faces

[![License: MIT](https://img.shields.io/badge/License-MIT-gold.svg)](LICENSE)
[![Live demo](https://img.shields.io/badge/demo-poker.orangecloud.vn-emerald)](https://poker.orangecloud.vn)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Sycule-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/Sycule)

**Open-source** private play-money Texas Hold'em for friends. **Your table. Your people.**

Live app: [https://poker.orangecloud.vn](https://poker.orangecloud.vn)

Virtual chips only. No purchases, cash-out, wallets, or real-money language.

## Open source

This repository is public under the [MIT License](LICENSE). You are welcome to fork, study, and contribute — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Support the project

If Poker Faces helps your group play online, you can [buy me a coffee](https://buymeacoffee.com/Sycule). It helps keep the lights on for hosting and new features.

## Stack

- React SPA/PWA + Vite + `@cloudflare/vite-plugin`
- Single Worker for static assets + HTTP APIs
- SQLite-backed Durable Object per room (hibernatable WebSockets)
- D1 (users, sessions, rooms, hand summaries)
- KV / R2 / Queues / Analytics Engine / Rate Limiting
- Username + email + password auth (PBKDF2) with cookie sessions; optional GitHub/Google OAuth; signed-in password change
- Host-approved private tables, text chat, optional voice
- PWA manifest + service worker shell cache
- Voice via Cloudflare RealtimeKit (degraded-safe when unset)

## Quick start

```bash
git clone https://github.com/sycu8/poker-face.git
cd poker-face
npm install
cp .env.example .dev.vars
# set SESSION_SECRET at minimum
# optional: GITHUB_CLIENT_ID/SECRET and GOOGLE_CLIENT_ID/SECRET for social login
npm run db:migrate:local
npm run dev
```

### OAuth (optional)

1. Create a GitHub OAuth App and/or Google OAuth client.
2. Set callback URLs to `{APP_ORIGIN}/api/auth/oauth/github/callback` and `{APP_ORIGIN}/api/auth/oauth/google/callback`.
3. Put client id + secret in `.dev.vars` (local) or GitHub Actions / Worker secrets (deploy).
4. Buttons appear on `/auth` only when both id and secret for that provider are present.

## Scripts

| Script                     | Purpose                       |
| -------------------------- | ----------------------------- |
| `npm run dev`              | Vite + Worker local           |
| `npm run typecheck`        | TypeScript                    |
| `npm run test`             | Vitest (domain + worker)      |
| `npm run test:domain`      | Poker engine tests            |
| `npm run build`            | Production build              |
| `npm run cf-typegen`       | Generate Worker binding types |
| `npm run db:migrate:local` | Apply D1 migrations locally   |

## Brand

See `docs/BRAND_GUIDE.md` and `logo/`.

## Docs

- [`docs/ROADMAP.md`](docs/ROADMAP.md) — shipped state, gaps, and phased product plan
- [`docs/GAME_RULES.md`](docs/GAME_RULES.md) — play-money rules
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Worker / DO / D1 layout
- [`docs/DISCOVERY_REPORT.md`](docs/DISCOVERY_REPORT.md) — production hardening baseline audit
- [`docs/CONSISTENCY_MODEL.md`](docs/CONSISTENCY_MODEL.md) — D1 ↔ Durable Object ordering and retries
- [`docs/ADVERSARIAL_QA.md`](docs/ADVERSARIAL_QA.md) — adversarial scenarios and verification matrix
- [`docs/PRODUCTION_SCORECARD.md`](docs/PRODUCTION_SCORECARD.md) — weighted production readiness scorecard
- [`docs/ROLLBACK.md`](docs/ROLLBACK.md) — Worker rollback and migration notes
- [`docs/BRAND_GUIDE.md`](docs/BRAND_GUIDE.md) — brand and copy
- [`docs/GITHUB_ACTIONS_DEPLOY.md`](docs/GITHUB_ACTIONS_DEPLOY.md) — staging/production deploy
- [`docs/VOICE_SETUP.md`](docs/VOICE_SETUP.md) — RealtimeKit voice + optional TURN secrets

## Environments

Keep local, staging, and production resources separate. Fill IDs in `wrangler.jsonc` from created Cloudflare resources; never commit secrets. Use `wrangler.template.jsonc` as the ID-free reference.

**GitHub Actions deploy:** see [`docs/GITHUB_ACTIONS_DEPLOY.md`](docs/GITHUB_ACTIONS_DEPLOY.md). Set `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `SESSION_SECRET`, then run **Deploy Cloudflare** (`all`).

Production deploy requires an explicit gate report and approval for manual ops; the Actions workflow is the supported path when secrets are configured.
