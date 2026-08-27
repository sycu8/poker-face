# Production scorecard — Poker Faces

Date: 2026-08-27 · Branch: `cursor/prod-hardening-pass-4c45`  
Evidence baseline: `npm test` → **124 passed** · lint / format / typecheck / build green

## Scoring model (fixed)

| Category                    |     Max |
| --------------------------- | ------: |
| Poker correctness           |      25 |
| State integrity & realtime  |      20 |
| Security & abuse resistance |      15 |
| Auth & Turnstile            |      10 |
| CI/CD & rollback            |      10 |
| Observability & operations  |       8 |
| Mobile UX                   |       7 |
| Performance/PWA             |       5 |
| **TOTAL**                   | **100** |

Statuses:

| Range  | Verdict                             |
| ------ | ----------------------------------- |
| 0–69   | NOT STAGING READY                   |
| 70–84  | STAGING READY, NOT PRODUCTION READY |
| 85–94  | PRODUCTION CANDIDATE                |
| 95–100 | PRODUCTION READY                    |

**Cap rule:** any unresolved P0/blocker → **NOT PRODUCTION READY** (even if uncapped score ≥ 85).

---

## Category scores

| Category                    |   Score | Notes                                                                                                                                             |
| --------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Poker correctness           | 23 / 25 | HU, short all-in, side pots, TDA odd chip, 3→2 HU, `validateAndResolveAction` zero-mutation rejects                                               |
| State integrity & realtime  | 17 / 20 | Join re-ensure, approve idempotent, `membership_ops` outbox, `safeSend`, voice single-flight (no `blockConcurrencyWhile`)                         |
| Security & abuse resistance | 13 / 15 | UTF-8 WS 8KiB + strict Zod; chat RL; Origin; Turnstile preserved (no site-key change)                                                             |
| Auth & Turnstile            |  8 / 10 | Dummy PBKDF2 = 300k; legacy rehash; guest identity idempotency; prod deploy requires Turnstile secret — live siteverify not re-proved in this run |
| CI/CD & rollback            |  9 / 10 | Deploy validate = full CI; canonical health required (no Wrangler false-green); Environment approval is manual                                    |
| Observability & operations  |   5 / 8 | Analytics + session purge + membership flush cron; limited alerting                                                                               |
| Mobile UX                   |   5 / 7 | Existing table UX unchanged this pass                                                                                                             |
| Performance/PWA             |   3 / 5 | VoicePanel + HandHistory lazy; Table chunk still large (~680KB; RealtimeKit still via provider)                                                   |

**Weighted total: 83 / 100**

Uncapped band: **STAGING READY, NOT PRODUCTION READY**.

---

## P0 blockers (manual / dashboard — not claimed complete)

| Blocker                                                                            | Owner action                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| WAF/Bot exception for exact `GET /api/health`                                      | Required so production smoke can pass without false-green |
| GitHub Environment `production` required reviewers                                 | Manual approval before public promote                     |
| Confirm `SESSION_SECRET_PRODUCTION` + `TURNSTILE_SECRET_KEY_PRODUCTION` in Actions | Deploy now hard-fails if missing                          |
| Confirm live Turnstile siteverify on production                                    | Widget + secret already expected present                  |

Because ≥1 P0 item requires dashboard verification outside this agent run, verdict remains **STAGING READY, NOT PRODUCTION READY**.

---

## What improved on this pass

- D1/DO join/approve/leave/kick convergence + docs
- Invalid actions cannot settle time bank / mutate state
- Production smoke cannot succeed on Wrangler metadata alone
- Deploy gate runs lint + format + typecheck + full test + build
- Voice provision no longer globally blocks the room DO
- PBKDF2 dummy cost aligned; guest join identity-idempotent; UTF-8 WS limit

---

## Sign-off checklist (human)

- [ ] Staging deploy green with real D1/KV IDs + migration `0008_membership_ops`
- [ ] Cloudflare WAF path exception for `/api/health` only
- [ ] Canonical `https://poker.orangecloud.vn/api/health` returns 200 + `ok` + `environment:production`
- [ ] Production Environment required reviewers enabled
- [ ] Production secrets present (SESSION, Turnstile)
- [ ] Explicit product owner approval to promote
