# GitHub Actions deploy secrets

This repo deploys with `.github/workflows/deploy.yml` using **GitHub Actions secrets** (and optional repository/environment variables).

## Required repository secrets

| Secret                                                                     | Purpose                                                                                                               |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                                                     | Wrangler deploy + resource create (Workers, D1, KV, R2, Queues edit)                                                  |
| `CLOUDFLARE_ACCOUNT_ID`                                                    | Cloudflare account id                                                                                                 |
| `SESSION_SECRET` or `SESSION_SECRET_PRODUCTION` / `SESSION_SECRET_STAGING` | Session HMAC secret. When set, deploy uploads it via `wrangler secret bulk`. When unset, deploy **skips** secret bulk and retains existing Worker secrets (never generates ephemeral values). |
| `TURNSTILE_SECRET_KEY` or `TURNSTILE_SECRET_KEY_PRODUCTION`                | Turnstile siteverify. Recommended for production; if unset, existing Worker secret is retained.                                                                    |
| `TURNSTILE_SITE_KEY_PRODUCTION` (secret or var)                            | Public Turnstile site key written into Wrangler vars. Empty values warn but no longer hard-fail the job.                                                          |

## Recommended secrets

| Secret                                                   | Purpose                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `TURNSTILE_SECRET_KEY_STAGING`                           | Staging Turnstile siteverify                                                                                              |
| `REALTIMEKIT_API_TOKEN`                                  | Voice: dedicated Cloudflare API token with **Realtime Admin**. Do **not** fall back to the deploy `CLOUDFLARE_API_TOKEN`. |
| `REALTIMEKIT_APP_ID`                                     | RealtimeKit app id (can also be a variable; also set as Wrangler var)                                                     |
| `REALTIMEKIT_PRESET_NAME`                                | RealtimeKit preset for participants (default `group_call_participant`)                                                    |
| `D1_DATABASE_ID_STAGING` / `D1_DATABASE_ID_PRODUCTION`   | Optional; auto-created if omitted                                                                                         |
| `KV_NAMESPACE_ID_STAGING` / `KV_NAMESPACE_ID_PRODUCTION` | Optional; auto-created if omitted                                                                                         |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`                     | Optional Calls TURN key (ops only; RealtimeKit voice does not need them)                                                  |

**Voice:** set `REALTIMEKIT_API_TOKEN` (repo or Environments **`staging`** / **`production`**). Deploy does **not** copy `CLOUDFLARE_API_TOKEN` into the Worker as a RealtimeKit token.

Voice setup details: [`docs/VOICE_SETUP.md`](VOICE_SETUP.md).

## Optional repository / environment variables

| Variable                                     | Default                                |
| -------------------------------------------- | -------------------------------------- |
| `APP_ORIGIN_STAGING`                         | `https://staging.poker.orangecloud.vn` |
| `APP_ORIGIN_PRODUCTION`                      | `https://poker.orangecloud.vn`         |
| `TURNSTILE_SITE_KEY_STAGING` / `_PRODUCTION` | production must be non-empty           |
| `REALTIMEKIT_APP_ID`                         | —                                      |
| `REALTIMEKIT_PRESET_NAME`                    | `group_call_participant`               |

Create GitHub Environments named `staging` and `production` (workflow references them). Add protection rules on `production` if desired.

## Smoke checks

- **Production:** only `APP_ORIGIN_PRODUCTION` (default `https://poker.orangecloud.vn`) `/api/health` — job **fails** if the canonical origin is unreachable (no workers.dev success path).
- **Staging:** prefers custom domain; may fall back to workers.dev with a warning.

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
