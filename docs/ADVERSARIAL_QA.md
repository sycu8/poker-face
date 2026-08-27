# Adversarial QA — Poker Faces

Date: 2026-08-27 · Branch: `cursor/production-hardening-4c45`

This document records adversarial scenarios (mission §22), the **expected safe behavior**, the **invariant** that must hold, and **verification status** on this branch.

Legend: **Auto** = covered by automated tests or CI; **Manual** = requires scripted QA / browser / dashboard; **Partial** = code exists but not fully exercised in CI.

---

## WebSocket / game actions

| Scenario                                                    | Expected safe behavior                                                                     | Invariant                                            | Status                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------- |
| **Devtools fabricated action** (forged `type: action` JSON) | Zod schema rejects unknown types/fields; engine rejects illegal moves; no state change     | Only validated, legal actions mutate `game.sequence` | **Auto** — `tests/domain/wsProtocol.test.ts`; engine tests        |
| **Duplicate WS action** (same `idempotencyKey` + payload)   | Second message returns fresh projection; no double bet                                     | At-most-once apply per key per hand (DO cache)       | **Auto** — `BoundedIdempotencyCache` tests; DO logic              |
| **Idempotency key reuse, different payload**                | `409`-style error `idempotency_conflict`; no mutation                                      | Same key cannot mean two different intents           | **Auto** — wsProtocol + DO                                        |
| **Stale `expectedVersion`**                                 | Error `stale_state` + private snapshot; action ignored                                     | Clients cannot apply against old sequence            | **Auto** — DO rejects mismatch; analytics `stale_action_rejected` |
| **Forged raise amount** (above stack / below min)           | `applyAction` rejects; stack unchanged                                                     | Engine enforces min-raise and stack caps             | **Auto** — `tests/domain/engine*.test.ts`                         |
| **NaN / Infinity amount**                                   | Parse rejected before engine                                                               | No non-finite chips enter engine                     | **Auto** — `wsProtocol.test.ts`                                   |
| **Missing `idempotencyKey` on action**                      | Schema validation failure                                                                  | All poker actions require client key                 | **Auto** — wsProtocol                                             |
| **Giant payload** (> 8 KiB)                                 | Error + WS close `1009`                                                                    | Bounded parse surface                                | **Auto** — wsProtocol                                             |
| **Chat flood**                                              | Per-user token bucket; error “Slow down”                                                   | Chat cannot DoS the room                             | **Auto** — `ChatRateLimiter` tests; DO                            |
| **Reconnect races** (send while reconnecting)               | `useRoomSocket` disables actions until snapshot; stale version rejected server-side        | UI cannot act on stale or partial state              | **Partial** — hook + DO; **Manual** — flaky-network QA            |
| **Second tab / duplicate WS**                               | Both sockets receive projections; only one actor seat; stale tab gets `stale_state` on act | Seat actions serialized by DO single-thread          | **Manual** — two-browser test                                     |
| **WS without membership**                                   | HTTP 403 before upgrade                                                                    | Non-members cannot open room socket                  | **Manual** — `scripts/qa-seed-and-pass.mjs`                       |
| **Pause / start_hand by non-host**                          | Error; no state change                                                                     | Host-only controls enforced in DO                    | **Auto** — engine/DO paths                                        |
| **Alarm race** (timer fires early/wrong hand)               | `alarmExpectation` guard; resync or noop                                                   | Timeout never folds wrong player                     | **Partial** — DO code; **Manual** — timer QA                      |

---

## HTTP / auth / join

| Scenario                                   | Expected safe behavior                                            | Invariant                                 | Status                                                          |
| ------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| **Cross-origin POST with session cookie**  | `403 Origin not allowed` when `Origin` present and ≠ `APP_ORIGIN` | Cookies not usable from arbitrary origins | **Auto** — `tests/domain/origin.test.ts`                        |
| **Missing Origin** (curl, CI scripts)      | Request allowed                                                   | Non-browser tooling still works           | **Auto** — origin tests                                         |
| **Join-request double submit**             | Same `idempotencyKey` → identical response; coalesce pending      | No duplicate pending rows for same user   | **Auto** — join coalesce tests; **Manual** — QA script          |
| **Join-decision retry**                    | Same host `idempotencyKey` → stored D1 response; no double seat   | Host approve/reject at-most-once          | **Auto** — D1 scope `join-decision:{hostId}` (this branch)      |
| **Non-host join-decision**                 | 403                                                               | Only host decides                         | **Manual** — QA script                                          |
| **SESSION_SECRET missing / rotated wrong** | Deploy fails; sessions invalid                                    | No ephemeral secret in prod deploy        | **Auto** — deploy workflow guard; **Manual** — dashboard secret |
| **Password reset takeover**                | Endpoint disabled 403                                             | No email-less account takeover            | **Auto** — auth route                                           |
| **Guest creates table**                    | 403                                                               | Guests cannot host                        | **Auto** — rooms route                                          |

---

## Data / privacy / infra

| Scenario                                 | Expected safe behavior                                          | Invariant                            | Status                                      |
| ---------------------------------------- | --------------------------------------------------------------- | ------------------------------------ | ------------------------------------------- |
| **Hole-card leak in projection**         | Foreign hole cards stripped                                     | `projectForPlayer` privacy           | **Auto** — engine privacy tests             |
| **Ledger CSV injection**                 | Escaped fields                                                  | Safe export                          | **Auto** — ledger tests                     |
| **Archive queue duplicate**              | D1 idempotency on `archive` scope                               | Hand summary written once            | **Partial** — worker queue handler          |
| **PWA caches `/api/*` or `/ws/*`**       | Network-only; SW returns early                                  | No stale auth or game API from cache | **Auto** — `public/sw.js` (v3)              |
| **PWA offline table state**              | `/table/*` navigations not shell-cached; game state never in SW | Offline shell only, not live table   | **Auto** — sw.js `isLivePath`               |
| **Close table mid-hand**                 | 409 / host guard                                                | No orphan chip state                 | **Partial** — DO close path; **Manual**     |
| **D1 vs DO membership drift**            | Documented reconcile model; retries idempotent                  | DO gameplay truth                    | **Partial** — `docs/CONSISTENCY_MODEL.md`   |
| **Voice token fallback to deploy token** | Removed; voice degrades safely                                  | Game never blocked by voice          | **Auto** — realtimekit + voice status tests |

---

## Recommended manual adversarial passes

1. **Browser devtools:** send raw WS `{type:"action",action:"raise",amount:999999,...}` — expect rejection.
2. **Network throttle:** drop WS mid-hand, reconnect, confirm snapshot before actions enabled.
3. **Host double-click approve:** same `idempotencyKey` — one seat, identical JSON on retry.
4. **Wrong Origin fetch:** `fetch('/api/auth/logout',{method:'POST',credentials:'include',headers:{Origin:'https://evil.test'}})` — 403.
5. **Production smoke:** canonical `APP_ORIGIN` `/api/health` only (deploy workflow).

Record failures in GitHub Issues with repro steps and link back to this matrix.
