# Architecture

- **Client:** React SPA/PWA (Vite) with branded UI, username/password auth, room table, chat, optional RealtimeKit voice.
- **Worker:** Single entry serves Static Assets + `/api/*` + `/ws/*`.
- **RoomDurableObject:** One SQLite DO per room — authoritative engine, hibernatable WebSockets, alarms for turn timers, text chat.
- **D1:** Users (username + password hash), sessions, rooms, membership, join requests, hand summaries, idempotency keys.
- **KV:** Non-authoritative config lookups only.
- **R2 + Queues:** Async hand archival / replay JSON.
- **Analytics Engine:** Aggregate events without PII.
- **Rate limits + Turnstile:** Registration and join abuse paths.

Privacy: `projectForPlayer` strips foreign hole cards. Voice failure never blocks game actions.
