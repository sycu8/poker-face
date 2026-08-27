# Production scorecard — Poker Faces

Date: 2026-08-27 · Branch: `cursor/prod-hardening-pass-4c45`  
Evidence baseline: `npm test` → **124 passed** · lint / format / typecheck / build green

## Scoring model (fixed)

| Category                    |     Max |
| --------------------------- | ------: |
| Poker correctness           |      25 |
| State integrity & realtime  |      20 |
| Security & abuse resistance |      15 |
| Auth                        |      10 |
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

| Category                    |   Score | Notes                                                                                                                                    |
| --------------------------- | ------: | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Poker correctness           | 23 / 25 | HU, short all-in, side pots, TDA odd chip, 3→2 HU, `validateAndResolveAction` zero-mutation rejects                                      |
| State integrity & realtime  | 17 / 20 | Join re-ensure, approve idempotent, `membership_ops` outbox, `safeSend`, voice single-flight                                             |
| Security & abuse resistance | 13 / 15 | UTF-8 WS 8KiB + strict Zod; chat RL; Origin; rate limits + Origin checks                                                                 |
| Auth                        |  8 / 10 | Dummy PBKDF2=300k; guest idempotency; Turnstile removed (rate limits remain); secret values not readable via API (owner attested)        |
| CI/CD & rollback            |  9 / 10 | Full CI in deploy validate; **canonical health verified 200** (no Wrangler false-green path); Environment required reviewers still empty |
| Observability & operations  |   5 / 8 | Analytics + session purge + membership flush cron; limited alerting                                                                      |
| Mobile UX                   |   5 / 7 | Existing table UX unchanged this pass                                                                                                    |
| Performance/PWA             |   3 / 5 | VoicePanel + HandHistory lazy; Table chunk still ~680KB                                                                                  |

**Weighted total: 84 / 100**

Uncapped band: **STAGING READY, NOT PRODUCTION READY**.

Capped verdict (remaining P0): **STAGING READY, NOT PRODUCTION READY**.

---

## Manual actions verification (2026-08-27)

| Action                                             | Owner claim | Agent verification                                                                                               |
| -------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| WAF / Bot exception for exact `GET /api/health`    | Completed   | **VERIFIED indirectly** — `https://poker.orangecloud.vn/api/health` → HTTP 200 + `ok` + `environment:production` |
| Canonical health must succeed                      | Completed   | **VERIFIED** — body `{"ok":true,"service":"poker-faces","environment":"production",...}`                         |
| `SESSION_SECRET` in Actions                        | Completed   | **NOT READABLE** — Actions secrets API returns 403 for this token; owner attestation only                        |
| GitHub Environment `production` required reviewers | Completed   | **NOT VERIFIED** — API shows `protection_rules: []` and `deployment_branch_policy: null`                         |

### Remaining P0

1. **Enable required reviewers** on GitHub Environment `production`  
   Settings → Environments → production → **Required reviewers** (at least one reviewer).  
   Current API snapshot still has zero protection rules.

Until that rule is visible, production promotion is not gated by a human approval gate in GitHub.

---

## What improved on this pass

- D1/DO join/approve/leave/kick convergence + docs
- Invalid actions cannot settle time bank / mutate state
- Production smoke cannot succeed on Wrangler metadata alone
- Deploy gate runs lint + format + typecheck + full test + build
- Voice provision no longer globally blocks the room DO
- PBKDF2 dummy cost aligned; guest join identity-idempotent; UTF-8 WS limit
- Canonical production health now reachable (verified)

---

## Sign-off checklist (human)

- [ ] Staging deploy green with real D1/KV IDs + migration `0008_membership_ops`
- [x] Cloudflare WAF path exception for `/api/health` only (inferred from successful probe)
- [x] Canonical `https://poker.orangecloud.vn/api/health` returns 200 + `ok` + `environment:production`
- [ ] Production Environment required reviewers enabled (**API still empty**)
- [x] Production secrets present (SESSION) — **owner attested; agent cannot list secrets**
- [ ] Explicit product owner approval to promote
