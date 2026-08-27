/**

# D1 ↔ Durable Object consistency model

## 1. Authoritative stores by category

| State                                                                        | Authority                              | Replica / metadata                        |
| ---------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------- |
| Hand, stacks, bets, cards, timers, chat (live), ledger, pending joins (live) | Room Durable Object                    | D1 mirrors membership / join_request rows |
| Users, sessions, room rows, membership, join requests, idempotency keys      | D1                                     | DO may mirror pending joins for host UI   |
| Membership convergence ops (`membership_ops`)                                | D1 outbox                              | Flushed on mutate paths + cron            |
| Hand summaries / replay JSON                                                 | R2 (via archive queue); D1 summary row | Queue idempotent                          |
| Public config flags/copy                                                     | KV (non-authoritative)                 | —                                         |

Gameplay state MUST NOT move to D1.

## 2. Operation ordering (implemented)

Mutating flows that touch both stores:

1. **Validate** auth + rate limits (Worker).
2. **Idempotency claim** in D1 when the operation has a client key.
3. **Durable Object mutation** (authoritative gameplay / seat / leave / kick / join card).
4. **D1 metadata update** via `applyMembershipOrEnqueue` (seat / spectator / leave / kick).
5. On D1 failure after DO success: row lands in `membership_ops`; flush retries (request path + cron).

### Join request

1. Insert/coalesce D1 `join_requests` pending row (stable `requestId` + user).
2. `ensureJoinRequestInDo` upserts the pending card (idempotent by `requestId` / `userId`).
3. If DO ensure fails, D1 pending remains; **client retry re-ensures DO** (including when an existing D1 pending row is returned).

### Approve

1. DO `/approve` seats or spectates (idempotent if already seated).
2. D1 membership + join_request approved via `applyMembershipOrEnqueue`.
3. Retry of the same approve converges without assigning a second seat.

### Leave / kick

1. DO leave/kick succeeds (authoritative unseat).
2. D1 status update via outbox-backed apply.
3. Retry is safe: DO returns ok when already gone; D1 flush sets `left` / `kicked`.

## 3. Partial failure behavior

- **DO ok, D1 fail:** Gameplay correct; membership may lag until `flushMembershipOps`.
- **D1 pending ok, DO join ensure fail:** Guest/host wait; retry re-pushes join into DO (no duplicate cards).
- **Never** invent mid-hand chip refunds across stores.

## 4. Retry / reconciliation

- Client retries use the same `idempotencyKey`.
- Guest `/join-as-guest` scopes identity under `guest-join` + key (no duplicate guests).
- Cron (`scheduled`) flushes bounded `membership_ops`.
- Poison pills drop after 8 failed attempts.

## 5. Duplicate requests

- Same key + same payload → return prior success (no double seat / double act).
- Same key + different payload → 409 conflict where enforced.
- Missing key on state-changing poker WS action → reject (required).

*/

export {};
