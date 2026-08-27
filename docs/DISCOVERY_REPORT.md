# DISCOVERY REPORT — Poker Faces production hardening

Date: 2026-08-27  
Repo: `sycu8/poker-face` · Branch: `cursor/production-hardening-4c45`  
Baseline: `npm run test:domain` → **49 passed**

## A. Current architecture

```
Browser (React SPA/PWA)
  → Cloudflare Worker (worker/index.ts)
    → Room Durable Object (authoritative realtime poker)
    → D1 (users, sessions, rooms, membership, joins, summaries, idempotency)
    → KV CONFIG_KV (non-authoritative flags/copy)
    → R2 + ARCHIVE_QUEUE (hand archive / replay)
    → Analytics Engine (aggregate events)
    → Rate limits (AUTH / JOIN)
    → Optional RealtimeKit voice
```

- **Authoritative gameplay** lives only in the Room DO (`worker/room/RoomDurableObject.ts` + `worker/domain/engine.ts`).
- Frontend: Vite + React 19; table UI dominated by `src/features/table/TablePage.tsx` (~1402 lines).
- Zod is already a dependency; no Redis/Firebase/second realtime stack.

## B. Existing tests

| Suite                           | Coverage                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `tests/domain/engine.test.ts`   | cards, hand ranks, side pots, privacy, HU fold, leave/rebuy/away, pause, time bank, rabbit |
| `tests/domain/ledger.test.ts`   | buy-in/out, CSV injection                                                                  |
| `tests/domain/password.test.ts` | PBKDF2                                                                                     |
| `tests/domain/*`                | bots, join coalesce, realtimekit parse, seat layout, voice status                          |
| `tests/ui/*`                    | playing card, seat layout, win celebration                                                 |

**Gaps:** heads-up blinds, raise reopen / short all-in, legal call-all-in, short BB, force-fold leave, deferred leave settlement, WS validation, CI lint/format, production smoke false-green.

## C. Current authoritative state model

| Category                              | Authority                         | Notes                          |
| ------------------------------------- | --------------------------------- | ------------------------------ |
| Hand / stacks / bets / cards / timers | Room DO                           | Correct placement              |
| Membership / rooms / sessions         | D1                                | Can diverge on partial failure |
| Chat (live)                           | DO memory (capped 100 on persist) | No rate limit                  |
| Action idempotency                    | In-memory Map on DO               | Lost on eviction               |
| Join idempotency                      | D1 `idempotency_keys`             | Join-decision key unused       |
| Ledger                                | DO snapshot                       | Deferred leave buyout buggy    |

## D. Relevant files

- Engine: `worker/domain/engine.ts`, `pots.ts`, `cards.ts`, `handRank.ts`, `ledger.ts`, `config.ts`
- DO: `worker/room/RoomDurableObject.ts`
- HTTP: `worker/index.ts`, `worker/routes/rooms.ts`, `worker/auth/*`, `worker/voice/realtimekit.ts`
- Frontend: `TablePage.tsx`, `HomePage.tsx`, `AuthPage.tsx`, `api.ts`, `public/sw.js`
- Ops: `wrangler.jsonc`, `.github/workflows/{ci,deploy}.yml`, `scripts/ci-*.mjs`, `migrations/*`
- Docs: `ARCHITECTURE.md` (stale reset-password), `GAME_RULES.md`, `GITHUB_ACTIONS_DEPLOY.md`

## E. Exact files expected to modify (by phase)

**Phase 1:** `engine.ts`, `pots.ts`, `cards.ts`, `tests/domain/engine*.test.ts`, `RoomDurableObject.ts` (leave/close/ledger)  
**Phase 2:** `RoomDurableObject.ts` (WS schema, idempotency, chat RL, alarms)  
**Phase 3:** `rooms.ts`, consistency doc, join-decision idempotency  
**Phase 4:** `passwordAuth.ts`, `password.ts`, `session.ts`, guest join endpoint, `HomePage.tsx`  
**Phase 5:** `ci.yml`, `deploy.yml`, `wrangler.jsonc`, secrets scripts  
**Phase 6:** `realtimekit.ts`, deploy secret fallback removal  
**Phase 7:** analytics/logging, retention cron, docs  
**Phase 8:** `useRoomSocket`, ActionDock, TablePage/CSS  
**Phase 9:** lazy routes, SW cache  
**Phase 10:** `ADVERSARIAL_QA.md`, `PRODUCTION_SCORECARD.md`

## F. Risks

| Risk                                                 | Severity    |
| ---------------------------------------------------- | ----------- |
| Engine raise/HU/side-pot bugs → chip-wrong play      | **BLOCKER** |
| Deferred leave records buyout 0 / never              | **BLOCKER** |
| SESSION_SECRET generated per deploy                  | **BLOCKER** |
| Production smoke false-green via workers.dev         | **BLOCKER** |
| Stale/duplicate WS actions; unbounded idem Map       | HIGH        |
| Close table mid-hand without conflict                | HIGH        |
| Voice meeting race; CF token as RealtimeKit fallback | HIGH        |
| Docs claim unsafe password reset                     | MEDIUM      |
| Frontend reconnect after unmount                     | MEDIUM      |

## G. Implementation order

Follow mission phases 0→10. No architecture replacement. Prefer small patches to existing patterns.
