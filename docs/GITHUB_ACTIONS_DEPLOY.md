# GitHub Actions deploy secrets

This repo deploys with `.github/workflows/deploy.yml` using **GitHub Actions secrets** (and optional repository/environment variables).

## Required repository secrets

| Secret                                                                     | Purpose                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                                                     | Wrangler deploy + resource create (Workers, D1, KV, R2, Queues edit)                                                                                                                          |
| `CLOUDFLARE_ACCOUNT_ID`                                                    | Cloudflare account id                                                                                                                                                                         |
| `SESSION_SECRET` or `SESSION_SECRET_PRODUCTION` / `SESSION_SECRET_STAGING` | Session HMAC secret. **Production deploy fails** if missing (no ephemeral generation). Staging may skip bulk and retain existing Worker secrets with a warning.                              |
| `TURNSTILE_SECRET_KEY` or `TURNSTILE_SECRET_KEY_PRODUCTION`                | Turnstile siteverify. **Required for production deploy.**                                                                                                                                   |
| `TURNSTILE_SITE_KEY_PRODUCTION` (secret or var)                            | Public Turnstile site key written into Wrangler vars.                                                                                                                                         |

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

**Voice:** set `REALTIMEKIT_API_TOKEN` (repo or Environments **`staging`** / **`production`**). Deploy does **not** copy `CLOUDFLARE_API_TOKEN` into the Worker as a RealtimeKit token. Voice secrets remain optional for core poker.

Voice setup details: [`docs/VOICE_SETUP.md`](VOICE_SETUP.md).

## Optional repository / environment variables

| Variable                                     | Default                                |
| -------------------------------------------- | -------------------------------------- |
| `APP_ORIGIN_STAGING`                         | `https://staging.poker.orangecloud.vn` |
| `APP_ORIGIN_PRODUCTION`                      | `https://poker.orangecloud.vn`         |
| `TURNSTILE_SITE_KEY_STAGING` / `_PRODUCTION` | production must be non-empty           |
| `REALTIMEKIT_APP_ID`                         | —                                      |
| `REALTIMEKIT_PRESET_NAME`                    | `group_call_participant`               |

## GitHub Environments

Create GitHub Environments named `staging` and `production` (workflow references them).

**Production Environment must require a reviewer / manual approval** before `deploy-production` runs for public production. This is configured in the GitHub UI (Settings → Environments → production → Required reviewers). Application code cannot fake Environment protection.

## Validate gate

`deploy.yml` `validate` runs the **same** suite as `ci.yml`:

- `npm ci`
- `npm run lint`
- `npm run format:check`
- `npm run typecheck`
- `npm test`
- `npm run build`

Production cannot deploy when full CI validations fail.

## Smoke checks

### Canonical production health (required)

`https://poker.orangecloud.vn/api/health` (or `APP_ORIGIN_PRODUCTION`) **must** return:

- HTTP **200**
- JSON containing `"ok": true` and `"environment": "production"`

If this fails, **production smoke fails**. Wrangler `deployments list` may be printed for diagnostics only — it **must not** convert a failed health check into success. There is **no** workers.dev fallback for production smoke.

### Staging

Prefers custom domain; may fall back to workers.dev with a warning.

### Cloudflare WAF / Bot Fight — smallest health-path exception

Configure a **path-specific** exception so GitHub Actions (and ops probes) can reach health without weakening site-wide bot protection:

1. Exact path: `/api/health` (method GET)
2. Bypass: Managed Challenge / Bot Fight Challenge for that path only
3. Keep the endpoint **uncached** (Worker response already sets health dynamically)
4. Do **not** expose secrets, user data, or internal IDs on `/api/health` (current payload: `ok`, `service`, `environment`, `tagline`)

Do **not** disable WAF/Bot Fight globally.

## Trigger

- **Manual:** Actions → Deploy Cloudflare → Run workflow → `all` / `staging` / `production`
- **Automatic:** push to `main` deploys staging then production (production still gated by Environment approval)

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
