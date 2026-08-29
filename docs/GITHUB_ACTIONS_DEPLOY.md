# GitHub Actions deploy secrets

This repo deploys with `.github/workflows/deploy.yml` using **GitHub Actions secrets** (and optional repository/environment variables).

## Required repository secrets

| Secret                                                                     | Purpose                                                                                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                                                     | Wrangler deploy + resource create (Workers, D1, KV, R2, Queues edit)                                                                                            |
| `CLOUDFLARE_ACCOUNT_ID`                                                    | Cloudflare account id                                                                                                                                           |
| `SESSION_SECRET` or `SESSION_SECRET_PRODUCTION` / `SESSION_SECRET_STAGING` | Session HMAC secret. **Production deploy fails** if missing (no ephemeral generation). Staging may skip bulk and retain existing Worker secrets with a warning. |

## Recommended secrets

| Secret                                                   | Purpose                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `REALTIMEKIT_API_TOKEN`                                  | Voice: dedicated Cloudflare API token with **Realtime Admin**. Do **not** fall back to the deploy `CLOUDFLARE_API_TOKEN`. |
| `REALTIMEKIT_APP_ID`                                     | RealtimeKit app id (can also be a variable; also set as Wrangler var)                                                     |
| `REALTIMEKIT_PRESET_NAME`                                | RealtimeKit preset for participants (default `group_call_participant`)                                                    |
| `D1_DATABASE_ID_STAGING` / `D1_DATABASE_ID_PRODUCTION`   | Optional; auto-created if omitted                                                                                         |
| `KV_NAMESPACE_ID_STAGING` / `KV_NAMESPACE_ID_PRODUCTION` | Optional; auto-created if omitted                                                                                         |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`                     | Optional Calls TURN key (ops only; RealtimeKit voice does not need them)                                                  |
| `OAUTH_GITHUB_CLIENT_ID` / `OAUTH_GITHUB_CLIENT_SECRET`  | Optional GitHub OAuth App credentials (both required to show **Continue with GitHub**). **Do not** name Actions secrets `GITHUB_*` — that prefix is reserved. Mapped to Worker secrets `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`              | Optional Google OAuth client credentials (both required to show **Continue with Google**)                                 |
| `TURNSTILE_SECRET`                                       | Cloudflare Turnstile widget secret (required for staging/production auth/join bot checks)                                 |

Per-environment overrides (optional): `OAUTH_GITHUB_CLIENT_ID_STAGING` / `_PRODUCTION`, `GOOGLE_CLIENT_ID_STAGING` / `_PRODUCTION`, matching `*_CLIENT_SECRET_*`, and `TURNSTILE_SECRET_STAGING` / `TURNSTILE_SECRET_PRODUCTION`.

Public Turnstile site key and hostname allowlists are Wrangler **vars** (`TURNSTILE_SITE_KEY`, `TURNSTILE_HOSTNAMES`) — not Actions secrets.

**OAuth callback URLs** (register in each provider console for every `APP_ORIGIN`):

- `{APP_ORIGIN}/api/auth/oauth/github/callback`
- `{APP_ORIGIN}/api/auth/oauth/google/callback`

**Voice:** set `REALTIMEKIT_API_TOKEN` (repo or Environments **`staging`** / **`production`**). Deploy does **not** copy `CLOUDFLARE_API_TOKEN` into the Worker as a RealtimeKit token. Voice secrets remain optional for core poker.

Voice setup details: [`docs/VOICE_SETUP.md`](VOICE_SETUP.md).

## Optional repository / environment variables

| Variable                  | Default                                |
| ------------------------- | -------------------------------------- |
| `APP_ORIGIN_STAGING`      | `https://staging.poker.orangecloud.vn` |
| `APP_ORIGIN_PRODUCTION`   | `https://poker.orangecloud.vn`         |
| `REALTIMEKIT_APP_ID`      | —                                      |
| `REALTIMEKIT_PRESET_NAME` | `group_call_participant`               |

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

Production smoke runs `node scripts/ci-smoke-health.mjs`, which:

1. Resolves the Cloudflare zone for the custom domain
2. Creates a **temporary IP Access Allow** for the GitHub Actions runner egress IP
3. Probes canonical `/api/health` until HTTP 200 + required JSON
4. Deletes the temporary Allow rule

This is required on zones with **Bot Fight Mode (Free)**: that product cannot be skipped with path-based WAF custom rules (Managed Challenge still returns 403 HTML to curl). Cloudflare evaluates IP Access Rules **before** Bot Fight Mode, so a short-lived runner Allow is the smallest Free-plan exception that still requires a real origin 200.

`CLOUDFLARE_API_TOKEN` needs at least:

- Zone → Zone → Read
- Zone → Firewall Services → Edit (IP Access Rules)

(or account-scoped equivalents that cover the `orangecloud.vn` zone)

### Staging

Prefers custom domain; may fall back to workers.dev with a warning.

### Cloudflare Bot Fight / WAF notes

| Plan / product                  | Path Skip for `/api/health`?                                                                         | What deploy smoke uses                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Bot Fight Mode (Free)**       | **No** — Skip/WAF rules do not bypass BFM                                                            | Temporary IP Access Allow for runner IP                        |
| **Super Bot Fight Mode (Pro+)** | Yes — Custom rule Skip → All Super Bot Fight Mode rules for `http.request.uri.path eq "/api/health"` | Same temp IP Allow (still works); optional permanent Skip rule |
| Global disable of Bot Fight     | Works but weakens the whole zone                                                                     | Avoid                                                          |

Keep `/api/health` **uncached** and free of secrets/user data (payload: `ok`, `service`, `environment`, `tagline` only).

Do **not** treat Wrangler deployment existence as health.

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
