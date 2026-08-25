# Voice (RealtimeKit + TURN)

Poker Faces voice uses **Cloudflare RealtimeKit**. The Worker mints a participant token; the browser joins with `@cloudflare/realtimekit-react`. Media relay (SFU/TURN) is handled inside RealtimeKit from that token — the game Worker does **not** call the TURN credential API for voice.

## Credential mapping

| What you have in the dashboard | Env / secret name | Used by |
| --- | --- | --- |
| RealtimeKit **App ID** | `REALTIMEKIT_APP_ID` | Worker `/api/rooms/:id/voice-token` |
| Cloudflare API token with **Realtime Admin** | `REALTIMEKIT_API_TOKEN` | Same (Bearer to `…/realtime/kit/…`) |
| Cloudflare **account id** | `CLOUDFLARE_ACCOUNT_ID` | Same (already set on Workers via deploy) |
| RealtimeKit **preset** name (must exist on the app) | `REALTIMEKIT_PRESET_NAME` | Participant create (`preset_name`). Default: `group_call_participant` |
| Calls **TURN** key id | `TURN_KEY_ID` (optional) | Ops / custom WebRTC only — not required for RealtimeKit voice |
| TURN key **API token** | `TURN_KEY_API_TOKEN` (optional) | `POST …/turn/keys/$ID/credentials/generate-ice-servers` |
| TURN key **name** (e.g. `poker-call`) | — | Dashboard label only; do **not** set as `REALTIMEKIT_PRESET_NAME` unless you also created a RealtimeKit preset with that exact name |

## Required for voice to leave `not_configured`

1. `REALTIMEKIT_APP_ID` — shipped as a Wrangler **var** (app `6867ec48-6a1e-43b9-b940-a542afad90d3`)
2. `REALTIMEKIT_API_TOKEN` — Cloudflare API token with **Realtime Admin** (secret; **not** the TURN key API token). If unset, Deploy Cloudflare falls back to **`CLOUDFLARE_API_TOKEN`** when that token includes Realtime Admin.
3. `CLOUDFLARE_ACCOUNT_ID` — Worker secret (already uploaded by Deploy Cloudflare CI)

Without (2), `/api/rooms/:id/voice-token` returns `{ available: false, reason: "not_configured", missing: [...] }` and the table still works.

### Cursor Cloudflare MCP

Interactive MCP login for Cloudflare bindings/observability only works in the **Cursor desktop IDE** (Settings → MCP → Cloudflare → Connect). Cloud agents cannot complete that OAuth flow.

## Upload secrets (never commit values)

### Local (gitignored)

Copy `.env.example` → `.dev.vars` and fill values. `.dev.vars` is gitignored.

### Worker (staging + production)

With a deploy-capable `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment:

```bash
# From repo root; values read from env (or export them first)
export REALTIMEKIT_APP_ID='…'
export REALTIMEKIT_API_TOKEN='…'   # Realtime Admin token
export CLOUDFLARE_ACCOUNT_ID='…'   # if not already a Worker secret
# optional:
# export REALTIMEKIT_PRESET_NAME='group_call_participant'
# export TURN_KEY_ID='…'
# export TURN_KEY_API_TOKEN='…'

node scripts/upload-voice-secrets.mjs staging
node scripts/upload-voice-secrets.mjs production
```

Or one key at a time:

```bash
printf '%s' "$REALTIMEKIT_APP_ID" | npx wrangler secret put REALTIMEKIT_APP_ID --env staging --config wrangler.jsonc
printf '%s' "$REALTIMEKIT_API_TOKEN" | npx wrangler secret put REALTIMEKIT_API_TOKEN --env staging --config wrangler.jsonc
# repeat for --env production
```

### GitHub Actions (so future deploys inject secrets)

Repository secrets (Settings → Secrets and variables → Actions):

- `REALTIMEKIT_APP_ID`
- `REALTIMEKIT_API_TOKEN`
- `REALTIMEKIT_PRESET_NAME` (optional; else default / repo variable)
- `CLOUDFLARE_ACCOUNT_ID` (already required for deploy)
- Optional ops: `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`

Then re-run **Deploy Cloudflare** (`all` / `staging` / `production`).

## Smoke check

Authenticated seated player:

`POST /api/rooms/:roomId/voice-token`

Expect `{ available: true, token, meetingId }` (never log the full token).  
If you still see `not_configured`, Worker secrets for RealtimeKit are missing on that environment.
