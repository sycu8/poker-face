# Poker Now parity (Hold’em-only)

Play-money Texas Hold’em improvements aimed at Poker Now–style friend tables. **No Omaha, bomb pot, or run-it-twice.** Server remains sole authority; foreign hole cards are never leaked.

## Guest join via invite

Friends can join from an invite **without a full account**:

1. Open the home page (optionally `/?invite=CODE`) or `/auth?mode=guest&invite=CODE`.
2. Enter a **display name** and continue as guest (Turnstile when configured).
3. Server creates a short-lived guest user (`users.is_guest = 1`) and a **24h** session cookie (`pf_session`).
4. Guest asks to join with the invite code; host approves to a seat or as **spectator**.
5. Guests can play chips, chat, and voice when configured.
6. Guests **cannot** create rooms or become host (host transfer only to registered members). Register to upgrade.

**Privacy:** Guest names are not accounts. They are ephemeral handles for one session, not reusable logins.

Rate limits: guest creation is keyed per IP via `AUTH_RATE_LIMIT`.

## Session ledger

Durable Object tracks per-player buy-in, buy-out, current stack, and net. Exposed on WS snapshots as `ledger` and via `GET /api/rooms/:id/ledger` (+ `?format=csv`).

## Host controls

- **Pause / Resume** — between hands blocks deal; mid-hand freezes the action timer.
- **Time bank** — host-configurable pool (default 60s); consumed after the primary turn timer before auto fold/check.
- **Transfer host** — to a registered (non-guest) member.
- **Close table** — kicks everyone, marks room closed, disconnects WS.
- **Practice bots** — host can **Add bot** on an open seat or **Fill open seats with bots**. Bots use starting stacks and auto-act in the Durable Object (not RealtimeKit voice). Kick removes them.

## Spectators

Unseated members with room access watch public info only (board, pots, shown hands at showdown). Distinct from seated sit-out / away.

## Hold’em polish

- Max seats **10**
- Larger board/hero cards (CSS)
- **Rabbit hunt** — after a hand, reveal remaining undealt board cards (fun only; no chip effect)

## Deferred

- Optional ante / live straddle (engine impact too large for this pass)
- Omaha / bomb pot / run-it-twice (explicitly out of scope)
