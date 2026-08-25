# GitHub Actions deploy secrets

This repo deploys with `.github/workflows/deploy.yml` using **GitHub Actions secrets** (and optional repository/environment variables).

## Required repository secrets

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler deploy + resource create (Workers, D1, KV, R2, Queues edit) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |
| `SESSION_SECRET` | Shared session HMAC secret (or use per-env overrides below). If unset, CI generates an ephemeral value each deploy (sessions reset). |

## Recommended secrets

| Secret | Purpose |
| --- | --- |
| `TURNSTILE_SECRET_KEY` | Turnstile siteverify |
| `REALTIMEKIT_API_TOKEN` | Voice participant provisioning (RealtimeKit API token) |
| `REALTIMEKIT_APP_ID` | RealtimeKit app id (can also be a variable) |
| `REALTIMEKIT_PRESET_NAME` | Optional; default `group_call_participant` — must match a preset on the RealtimeKit app |
| `SESSION_SECRET_STAGING` / `SESSION_SECRET_PRODUCTION` | Per-environment session secrets |
| `TURNSTILE_SECRET_KEY_STAGING` / `TURNSTILE_SECRET_KEY_PRODUCTION` | Per-environment Turnstile |
| `D1_DATABASE_ID_STAGING` / `D1_DATABASE_ID_PRODUCTION` | Optional; auto-created if omitted |
| `KV_NAMESPACE_ID_STAGING` / `KV_NAMESPACE_ID_PRODUCTION` | Optional; auto-created if omitted |

`CLOUDFLARE_ACCOUNT_ID` is required for Wrangler deploy **and** is uploaded as a Worker secret so the voice token endpoint can call the RealtimeKit REST API.

### Voice (RealtimeKit)

Without these Worker secrets, the table still works; Enable voice returns `reason: "not_configured"`:

1. `CLOUDFLARE_ACCOUNT_ID`
2. `REALTIMEKIT_APP_ID`
3. `REALTIMEKIT_API_TOKEN`
4. Optional `REALTIMEKIT_PRESET_NAME` (default `group_call_participant` — confirm the exact name in the Cloudflare RealtimeKit dashboard)

## Optional repository / environment variables

| Variable | Default |
| --- | --- |
| `APP_ORIGIN_STAGING` | `https://staging.poker.orangecloud.vn` |
| `APP_ORIGIN_PRODUCTION` | `https://poker.orangecloud.vn` |
| `TURNSTILE_SITE_KEY_STAGING` / `_PRODUCTION` | empty until widgets exist |
| `REALTIMEKIT_APP_ID` | — |
| `REALTIMEKIT_PRESET_NAME` | `group_call_participant` (code default if unset) |

Create GitHub Environments named `staging` and `production` (workflow references them). Add protection rules on `production` if desired.

## Trigger

- **Manual:** Actions → Deploy Cloudflare → Run workflow → `all` / `staging` / `production`
- **Automatic:** push to `main` deploys staging then production

## Vite + Cloudflare environments

This app uses `@cloudflare/vite-plugin`. Cloudflare envs are selected at **build** time:

1. `ci-prepare-wrangler.mjs` patches real D1/KV IDs into `wrangler.jsonc`
2. `CLOUDFLARE_ENV=staging|production npm run build` flattens that env into `dist/poker_faces/wrangler.json` (including `assets.directory`)
3. `wrangler deploy` (no `--env`) deploys the generated config

Do not run `wrangler deploy --env staging` against source `wrangler.jsonc` — it lacks `assets.directory` and will fail.

## Token permissions

The Cloudflare API token needs at least:

- Workers Scripts: Edit
- Workers KV Storage: Edit
- D1: Edit
- Workers R2 Storage: Edit
- Queues: Edit
- Account Settings: Read (for account id resolution)
- Workers Routes / Custom Domains as needed for `poker.orangecloud.vn`
