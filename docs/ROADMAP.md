# Roadmap

Scores (0–10): W wow · U usefulness · T technical value · C complexity · R risk · D demo value.
The full idea bank and scoring are in [MAXIMUM_POTENTIAL_AUDIT.md](MAXIMUM_POTENTIAL_AUDIT.md).

## Shipped in the maximum-potential pass (NOW)

| Feature | W | U | T | C | R | D |
|---|---|---|---|---|---|---|
| Validated AI output + prompt-injection isolation | 3 | 10 | 9 | 3 | 1 | 4 |
| Trader memory: scored calls, track records, calibration, risk budgets, similar setups | 8 | 9 | 9 | 5 | 3 | 8 |
| Structured "black box" (calls, conviction, five signals; no chain of thought) | 9 | 8 | 6 | 3 | 2 | 10 |
| Floor debate (opening views → challenges → final calls, mind changes) | 10 | 7 | 9 | 6 | 4 | 10 |
| Regime + market psychology + order-book signals + smart money | 9 | 7 | 7 | 3 | 2 | 9 |
| Humans vs AI, storyline, five achievements | 9 | 8 | 6 | 4 | 2 | 10 |
| Scenarios + 9-act reproducible demo + closing bell / Daily Wrap | 10 | 8 | 8 | 5 | 3 | 10 |
| Stage mode, spectators, mobile dock, provenance labels | 8 | 9 | 4 | 3 | 1 | 10 |
| Host lab (vol, liquidity, appetite, debate, memory, auto-news) + seeds | 7 | 7 | 7 | 4 | 3 | 6 |
| Admin/observability with cost intelligence; memory-vs-no-memory experiment table | 5 | 9 | 8 | 3 | 1 | 6 |
| Engine realism (stress-aware dealers, inventory cap, fvK decay, calmer momentum) | 6 | 6 | 8 | 3 | 4 | 6 |
| Security hardening + chaos tests; `.claude/` skills, agents, Stop-hook gate | 1 | 10 | 8 | 4 | 1 | 0 |

## Shipped in the "go beyond" pass

| Feature | W | U | T | C | R | D |
|---|---|---|---|---|---|---|
| Storyline titles + Timeline tab + reversal / humans-vs-machines / all-in detectors | 8 | 8 | 5 | 3 | 1 | 9 |
| AI science: debate experiment (opening vs final vs control), herding by regime, twins/rivals, desk accuracy | 9 | 7 | 9 | 4 | 2 | 8 |
| Tendencies (with/against the floor, stressed) fed back into prompts; return, max drawdown | 6 | 8 | 7 | 3 | 2 | 5 |
| Legends (all-time records) + "Previously on The Pit" | 8 | 7 | 5 | 3 | 2 | 9 |
| Host chaos controls (9 one-tap events) | 9 | 6 | 4 | 2 | 2 | 10 |
| Admin drill-down; crowd intel (human flow, news pressure); lobby explainer | 5 | 8 | 5 | 2 | 1 | 6 |

## NEXT (high impact, medium complexity)

| Feature | Why | Notes |
|---|---|---|
| **News chain reaction** (automatic second-order round when a headline moves the price > 3% in 60 s) | Emergence: the AI reacts to its own market | Needs a per-room "chain depth" budget so it can't loop; the scorebook already measures the move |
| **Market replay** with a scrubber | Sports-replay rewatch of a session | Record deltas per room (≈1.3 KB × 4/s ≈ 19 MB/hour) to Supabase storage or compress; second render mode in the client |
| **Leaderboards by metric** for humans (return, Sharpe-like, max drawdown, best trade, reaction speed) | Makes different styles viable | Drawdown and reaction time are now tracked per account; this is a UI and a Legends key or two |
| **Newsroom sections** (Breaking / Company / Rumour / AI / Player) | Easier scanning in busy LIVE rooms | Tags already exist; this is a filter UI |
| **QR code in stage mode** | Instant joining from a TV | Needs a small QR encoder (dependency review first) |
| **Per-trader evolution of style** (a trader on a long losing run rewrites its own voice/parameters) | Persistent characters | Lessons + budgets do part of this today |

## EXPERIMENTAL

| Feature | Notes |
|---|---|
| **What-if branching** (clone a market state, replay with a different decision) | The engine is deterministic per seed, but Claude isn't. Branches would need recorded AI responses to be fair |
| **Controlled AI experiments at scale**: static vs memory vs debating vs ensemble | Each room now runs the debate experiment live (opening vs final vs control). A proper study needs many rooms, a fixed scenario set, persisted science tallies and significance testing |
| **Ensemble trader** (a seventh trader that follows the floor's calibrated consensus) | Cheap to add once enough calls are scored; tests whether the crowd beats the individuals |
| **Prediction market side-game for humans** (humans make calls too, scored like the AI's) | Already scored implicitly from trades; needs explicit UI |

## FUTURE (the architecture leaves room)

- More data providers behind `MarketProvider` (Polygon/Massive, Alpha Vantage). The interface is four methods.
- Model upgrades: every role is an env var (`AI_MODEL_ROUND`, `_DEBATE`, `_NEWS`, `_ASK`, `_NARRATOR`).
- Horizontal scale: rooms are independent, so shard by room code if one process ever isn't enough (it is for dozens of rooms).
- Supabase Auth (magic link) if seats need to follow a person across devices.
- Trader portraits and sound design. Rejected for now: they risk the terminal aesthetic.
