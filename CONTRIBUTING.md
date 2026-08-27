# Contributing to Poker Faces

Thanks for helping improve Poker Faces. This project is open source under the [MIT License](LICENSE).

## Getting started

1. Fork the repo and clone your fork.
2. `npm install`
3. Copy `.env.example` to `.dev.vars` and set at least `SESSION_SECRET`.
4. `npm run db:migrate:local`
5. `npm run dev`

## Before you open a PR

- Run `npm run typecheck`, `npm run test`, and `npm run lint`.
- Keep changes focused — one logical fix or feature per PR.
- Match existing code style and naming in the files you touch.
- Do not commit secrets (`.dev.vars`, API tokens, Turnstile keys).

## Scope notes

- **Play money only** — no real-money flows, wallets, or purchases in-app.
- **Security** — report vulnerabilities privately to the repo owner rather than in public issues when possible.

## Questions

Open a [GitHub Discussion](https://github.com/sycu8/poker-face/discussions) or issue for bugs and feature ideas.
