# token-radar-01-rebuild

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/anirhfx-agent/token-radar-01-rebuild/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/anirhfx-agent/token-radar-01-rebuild/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar — which tokenless protocols are worth a launch, ranked by expected launch value (implied FDV × token odds). Every value term is fitted to a frozen DefiLlama + CoinGecko snapshot (2026-11-23) and validated held-out twice: the mcap/TVL multiple is a category median (winsorised, with a $10k TVL peer floor), token odds come from the per-category peer base rate adjusted by TVL and age, an integrity strip scores each protocol on audits, Twitter, site, description, multi-chain, fork status and TVL tier, and every farm verdict is costed (gas by chain tier, a 4-transaction plan, a $500 suggested position, and an expected value where the reward is proportional to the farmer's share of the protocol). The dashboard renders the full 424-protocol board with a detail view per protocol and filters, with no network calls. Stablecoin products are excluded explicitly (18 entries — a stablecoin has no token left to launch — plus Kelp, whose governance token cannot be identified in the data); the full list with reasons is in `out/dossier.json`.

## Run it

```sh
node main.ts
```

This reads `data/snapshot.json`, fits the model, and writes `out/board.json` (the full 424-row board), `out/dossier.json` (methodology, model fit, held-out validation, assumptions and limitations), and `dashboard/index.html` (a self-contained static page — open it in a browser, no server or network needed). Deterministic: the same snapshot always produces byte-identical output. Requires Node.js 22.18+ (TypeScript runs natively). Stdlib only, no dependencies.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ani123&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
