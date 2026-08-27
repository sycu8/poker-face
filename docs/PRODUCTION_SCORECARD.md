# Production scorecard — Poker Faces

Date: 2026-08-27 · Branch: `cursor/production-hardening-4c45`  
Evidence baseline: `npm run test:domain` → **93 passed** · CI lint/format/typecheck/build on PR

Scoring: each category **0–10** × weight → weighted sum / 100.  
Verdict thresholds: **≥ 85** Production ready · **70–84** Production candidate · **55–69** Staging ready · **< 55** Not production ready.

**Cap rule:** any **P0 blocker requiring Cloudflare/GitHub dashboard config** not verified in this environment → verdict capped at **NOT PRODUCTION READY** regardless of code score.

---

## Category scores

| #   | Category                                                               | Weight | Score | Evidence / notes                                                                         |
| --- | ---------------------------------------------------------------------- | -----: | ----: | ---------------------------------------------------------------------------------------- |
| 1   | **Engine correctness**                                                 |     15 |     9 | HU/side pots/leave/deferred settlement fixes; 93 domain tests green                      |
| 2   | **Realtime safety** (WS schema, version, idempotency, chat RL, alarms) |     15 |     8 | `wsProtocol.ts`, DO hardening; limited WS integration tests                              |
| 3   | **Auth & sessions**                                                    |     10 |     8 | PBKDF2 rehash, guest TTL, reset disabled, cron purge; needs prod `SESSION_SECRET` verify |
| 4   | **Abuse controls** (Turnstile, rate limits, Origin)                    |     10 |     7 | Turnstile hostname bind; Origin check on POST/WS; prod Turnstile keys **manual**         |
| 5   | **Join / membership consistency**                                      |     10 |     7 | D1 idempotency join + join-decision; consistency doc; full reconcile job not shipped     |
| 6   | **Deploy & CI**                                                        |     10 |     8 | CI lint/format/test/build; deploy requires secrets; prod smoke canonical origin only     |
| 7   | **Observability & ops**                                                |      5 |     6 | Analytics events; session purge cron; no formal alert runbooks in repo                   |
| 8   | **PWA / client perf**                                                  |      5 |     7 | SW v3 no API cache; lazy Auth/Table routes; voice bundled in Table chunk                 |
| 9   | **Voice (optional)**                                                   |      5 |     6 | RealtimeKit isolated token; degrades safe; `REALTIMEKIT_API_TOKEN` **manual**            |
| 10  | **Documentation & QA**                                                 |      5 |     8 | DISCOVERY, CONSISTENCY, ADVERSARIAL_QA, ROLLBACK; QA scripts exist, not in CI            |
| 11  | **Secrets & infra separation**                                         |     10 |     5 | Wrangler template placeholders; staging/prod IDs & secrets **dashboard**                 |

**Weighted total:** `(9×15 + 8×15 + 8×10 + 7×10 + 7×10 + 8×10 + 6×5 + 7×5 + 6×5 + 8×5 + 5×10) / 100`  
= `(135 + 120 + 80 + 70 + 70 + 80 + 30 + 35 + 30 + 40 + 50) / 100` = **740 / 100 = 74.0**

Uncapped verdict: **PRODUCTION CANDIDATE** (70–84).

---

## P0 blockers (manual / dashboard)

These are **not** proven by code-only review in this agent run:

| Blocker                                                            | Owner action                      |
| ------------------------------------------------------------------ | --------------------------------- |
| `SESSION_SECRET` (or `_PRODUCTION`) set in GitHub + Worker secrets | Required; deploy fails if missing |
| Production `TURNSTILE_SECRET_KEY` + non-empty `TURNSTILE_SITE_KEY` | Turnstile fail-closed in prod     |
| `APP_ORIGIN_PRODUCTION` matches live custom domain                 | Smoke check + Origin validation   |
| D1/KV/R2/Queue IDs patched via `ci-prepare-wrangler.mjs`           | First deploy or secret vars       |
| Custom domain / route for `poker.orangecloud.vn`                   | Cloudflare dashboard              |
| Optional: `REALTIMEKIT_API_TOKEN` for voice                        | Voice works degraded without      |

Because ≥1 P0 item requires production dashboard verification **outside this branch**, the **capped verdict is NOT PRODUCTION READY** until a human confirms secrets, domain, and smoke on production.

**Recommended staged verdict after manual checklist:** **STAGING READY → PRODUCTION CANDIDATE** once staging deploy + QA script pass; **PRODUCTION READY** only after production secrets + smoke + explicit approval (see README deploy gate).

---

## What improved on this branch

- Engine blockers (raise/HU/leave/ledger) and expanded domain tests
- WS protocol validation, bounded idempotency, chat rate limit, alarm guards
- Turnstile single-use guest join, password/session hardening, Origin validation
- Join-decision D1 idempotency, consistency model doc
- PWA cache hygiene, lazy table/auth routes, rollback doc
- Deploy smoke false-green removed for production

---

## Sign-off checklist (human)

- [ ] Staging deploy green with real D1/KV IDs
- [ ] `scripts/qa-seed-and-pass.mjs` against staging
- [ ] Production secrets present (SESSION, Turnstile)
- [ ] `/api/health` on canonical origin
- [ ] Adversarial manual passes § ADVERSARIAL_QA (at least WS + join + Origin)
- [ ] Explicit product owner approval to promote
