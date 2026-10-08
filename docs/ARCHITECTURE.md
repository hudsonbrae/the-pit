# System map

```
                         REAL WORLD                              PLAYERS (phones, laptops, a TV)
                             │                                        │  ▲
          Finnhub (quotes · company news · status)                    │  │ WebSocket: intents up,
                             │  one poller per ticker                 │  │ ~4 deltas/s down + events
                             ▼                                        ▼  │
                     ┌──────────────┐        ┌────────────────────────────────────────────────┐
                     │  MARKET HUB  │──────► │                     ROOM                        │
                     │ cache·dedupe │ quote  │                                                │
                     └──────────────┘ news   │  ┌──────────── ENGINE (250 ms ticks) ────────┐ │
                                             │  │ order book · market makers · ~50 crowd    │ │
   Scenario runner ── shocks, programs, ───► │  │ bots · hidden fair value · candles ·      │ │
   (Sim only)         liquidity, halts       │  │ circuit breaker · real-price anchor       │ │
                                             │  └───────▲──────────────────────┬────────────┘ │
                                             │          │ validated orders      │ prints       │
   NEWS: LIVE · PLAYER · AI · SCENARIO ────► │  ┌───────┴────────┐     ┌───────▼────────────┐ │
                                             │  │   AI ROUND     │     │   INTELLIGENCE     │ │
                                             │  │ desk → 6 calls │     │ Scorebook: calls   │ │
                                             │  │ (or DEBATE:    │◄────│  scored at +60 s → │ │
                                             │  │  views →       │ track│  records, budgets │ │
                                             │  │  challenges →  │record│ MarketIntel:      │ │
                                             │  │  final calls)  │     │  regime, psych,    │ │
                                             │  └───────▲────────┘     │  book signals,     │ │
                                             │          │ JSON Lines   │  humans vs AI      │ │
                                             │   schema │ (validated)  │ Storyteller:       │ │
                                             │          │              │  moments, badges   │ │
                                             └──────────┼──────────────┴──────────┬─────────┘ │
                                                        │                         │
                                    Anthropic API (server-side key)      Supabase (secret key)
                                    Sonnet: rounds, debates              rooms · players · lessons
                                    Haiku: headlines, ask, narrator      trader_stats · news_log
                                    cost guard · watchdog · offline      leaderboards · ai_usage_daily
                                                                         legends
```

## The loop that makes it feel alive

1. **News arrives.** A real headline from Finnhub (LIVE), a player's headline (PLAYER), Claude's headline (AI) or a scripted event (SCENARIO).
2. **The desk reads it.** The first JSON line sets the fair-value shock and classifies the news (confirmed, rumour, opinion or noise; plus its category).
3. **The traders decide.** Each trader's line carries an action, a size, a **call** (up, down or flat over the next 60 s), a conviction, five **signals** (news, trend, value, flow, risk) and a public one-line rationale. On major news the floor **debates** first, over two calls: opening views, then challenges, then final decisions. Mind changes are recorded.
4. **The engine decides what is legal.** `ai/schema.ts` validates each line; risk budgets and position limits are enforced; orders hit the real book, 0.7 s apart.
5. **The market reacts.** Crowd bots chase fair value, and market makers widen and shrink under stress. Halts fire. Intel recomputes regime, psychology and book signals once a second.
6. **Reality scores the AI.** Sixty simulated seconds later every call is scored. Track records, calibration, streaks and the Oracle update. A trader on a cold streak or in drawdown gets a smaller risk budget, and all of it goes into the next prompt.
7. **The room learns about itself.** Each scored call also feeds the science module (did the debate change the call, and was the new call right? did the trader go with or against the floor? was the market stressed?). Tendencies and measured relationships go back into the prompts.
8. **The story is told.** The storyteller turns moves, splits, scored calls, timing, halts and leader changes into the live storyline. The closing bell assembles them into the Daily Wrap, and the narrator model writes the match report.

## Modules

| Path | Role |
|---|---|
| `server/engine.ts` | Exchange. Line-for-line port of the original, plus knobs (vol, liq, spread, crowd), stress-aware market makers, inventory cap, liquidity withdrawal, scripted programs, forced halt |
| `server/room.ts` | One room: frame loop, deltas, players and spectators, AI rounds and debates, scoring, scenarios, lab, closing bell |
| `server/intel/stats.ts` | Scorebook: calls → track records, calibration, reputation, risk budgets, similar past setups |
| `server/intel/market.ts` | Regime, psychology, order-book signals, smart money (observable state only) |
| `server/intel/stories.ts` | Storyline (titled moments + the timeline), detectors (reversal, humans vs machines, all-in), achievements |
| `server/intel/science.ts` | The running experiment: opening vs final vs no-debate accuracy, herding by regime, twins/rivals, desk direction |
| `server/legends.ts` | All-time records across rooms (persisted; memory fallback) |
| `server/scenarios.ts` | Scripted events with causal engine effects; the 9-act demo; host chaos controls |
| `server/prompts.ts` | System prompts (rules and format, cached) and data-only user turns (untrusted text tagged) |
| `server/ai/` | `anthropic.ts` (real), `fake.ts` (mock with personalities), `schema.ts` (validation), `llm.ts` (interface and line splitter) |
| `server/market/` | `MarketProvider` interface: Finnhub and a mock; `hub.ts` shares polling across rooms |
| `server/store/` | `Store` interface: Supabase or memory, always wrapped in `SafeStore` |
| `server/costguard.ts`, `server/costs.ts` | Caps, usage logging, cost estimates, persistence of the day's totals |
| `server/app.ts`, `server/admin.ts` | HTTP, WebSocket and limits; admin/observability page |
| `web/src/main.ts` | The client: renders state and sends intents |

## Design choices that keep it simple

- **One process, no queues, no extra services.** Rooms are objects in memory, and Postgres holds what must survive. The CPU cost is about 0.06 ms per room frame.
- **No event bus.** The room calls the scorebook, intel and storyteller directly at the few points where things happen (fill, round end, halt, frame). A bus would add indirection without removing any code. See DECISIONS.md.
- **Deterministic simulation where it matters.** Each room has a seed, and the demo uses a fixed seed. The crowd, market makers and offline rules are reproducible; Claude's words are not, by design.
