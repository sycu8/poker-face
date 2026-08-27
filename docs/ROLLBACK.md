# Rollback — Poker Faces

Short guide for reverting a bad Worker deploy on Cloudflare.

## Worker rollback (fastest)

1. **Cloudflare dashboard:** Workers & Pages → `poker-faces` (or `-staging`) → **Deployments** → select the last known-good deployment → **Rollback** / **Deploy**.
2. **Wrangler CLI:** from a checkout at the good commit:
   ```bash
   git checkout <good-commit>
   CLOUDFLARE_ENV=production npm run build
   npx wrangler deploy
   ```
   Note the new deployment **version id** in the deploy output for audit.

Static assets ship with the Worker bundle (Vite + `@cloudflare/vite-plugin`); rolling back the Worker rolls back the SPA shell served from that deployment.

## D1 migrations

- Migrations are **forward-only** in normal ops. Roll back the Worker first; only add a new migration if schema must be repaired.
- This app’s migrations to date are additive (`users`, `rooms`, `hand_summaries`, `idempotency_keys`). Older Workers remain compatible if new columns/tables are unused.
- **Never** run `migrations apply` against production from an unreviewed branch. Staging should receive migrations before production.

## Queues / R2

- **ARCHIVE_QUEUE:** consumer logic is idempotent (`idempotency_keys` scope `archive`). A rolled-back Worker may re-process messages safely; watch DLQ if archive errors spike.
- **REPLAY_R2:** objects are immutable per hand key; rollback does not delete R2 data.

## Secrets & vars

Rollback **does not** revert secrets. If a bad deploy changed only code, secrets (`SESSION_SECRET`, RealtimeKit) stay as configured.

Verify after rollback:

- `APP_ORIGIN` matches the live custom domain
- `SESSION_SECRET` unchanged (changing it invalidates all sessions)
- Cron trigger still present (`0 */6 * * *` session purge on staging/production)

## Version ID

Record the Cloudflare deployment **version id** from:

- Dashboard deployment detail, or
- `wrangler deployments list`

Include it in incident notes when rolling back.

## Client cache

Service worker cache name `poker-faces-shell-v3` bumps on intentional SW changes. After rollback, users may need one hard refresh if a bad SW shipped; rolling back Worker + redeploying a prior SW version clears on next activate event.

## When rollback is not enough

- **Bad D1 migration applied:** restore D1 from Cloudflare backup / point-in-time if available; ship a corrective migration.
- **SESSION_SECRET leaked:** rotate secret in dashboard, redeploy, accept global logout.
- **Data corruption in Room DO:** per-room; may require host to close table and reopen (DO state is authoritative for active hands).
