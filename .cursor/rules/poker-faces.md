# Cursor rules — Poker Faces

- Server is sole authority for cards, pots, timers, and config.
- Never send another player's hole cards to a client.
- No real-money / casino / wallet language in product copy.
- Prefer small reviewable patches; no unrelated refactors.
- Do not hardcode account IDs, secrets, or environment domains in source.
- Use Durable Object alarms for turn deadlines.
- Voice and chat failures must never block game actions.
- Follow `docs/GAME_RULES.md` and `docs/BRAND_GUIDE.md`.
