# The Pit

A live trading floor you play from your phone. Six Claude-powered AI traders read the
news, argue about it, trade it, and get scored on whether they were right. You and your
friends trade the same order book against them and against each other. The stock is
either fictional (Halcyon Dynamics, HLCN) or a real US stock whose real price and real
headlines drive the simulation.

**Fake money only.** Nothing here places real orders, connects to a brokerage or handles real money.

- **To get it online and send a link to a friend: [SETUP.md](SETUP.md)**, written for someone who has never deployed anything.
- How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Why: [DECISIONS.md](DECISIONS.md) · Next: [docs/ROADMAP.md](docs/ROADMAP.md) · Data: [docs/DATA.md](docs/DATA.md) · Audit: [docs/MAXIMUM_POTENTIAL_AUDIT.md](docs/MAXIMUM_POTENTIAL_AUDIT.md)

## What's on the floor

- **A real exchange, simulated.** It has a limit order book, market makers that widen and step back under stress, about 50 crowd bots, circuit breakers, and 5-second candles. The server is authoritative; phones only render.
- **Six AI traders with memory.** Every decision is a **call** (up, down or flat in 60 s, with a conviction) plus five **signals** (news, trend, value, flow, risk) and a one-line public rationale. No chain of thought is shown. Sixty seconds later reality scores the call. Each trader builds a track record, a confidence-vs-reality calibration, a reputation (ORACLE, HOT HAND, COLD, OVERCONFIDENT) and a risk budget the engine enforces. All of it goes into their next prompt: "you were wrong on the last management headline".
- **Floor debates.** On big news the six state opening views, challenge each other by name, and commit. Mind changes are shown and narrated.
- **Market intelligence**, all derived from state: the regime (calm, trending, volatile, panic, euphoria, liquidity crunch, halted), a fear/greed × bull/bear psychology map, order-flow and book signals (sell walls, thinning liquidity, aggressive buying), Humans vs AI, and smart money.
- **A storyline** that writes itself, with titled moments ("10:42 · THE FLOOR SPLITS", "THE REVERSAL", "HUMANS VS MACHINES", "ALL IN") and a **Timeline** tab that logs every headline, desk read, AI decision, big trade and scored call. Five tasteful achievements, and a **closing bell** with a Daily Wrap that Claude narrates: best and worst call, fastest human reaction, new records.
- **AI science, live.** In a debated round both the opening view and the final call are scored, so the room measures whether arguing made the floor smarter (vs no-debate rounds as the control). Plus herding by regime, measured "twins" and "rivals", each trader's accuracy with and against the crowd (fed back into their prompt), and whether the desk's read pointed the right way.
- **Legends and "Previously on The Pit".** All-time records across every room (best session, biggest win over the AI floor, fastest reaction, longest AI streak, wildest session) in the lobby, and each new session opens with what happened last time.
- **Host chaos controls:** news shock, flash crash, short squeeze, liquidity crisis, earnings beat/miss, AI panic, AI euphoria, market halt. One tap each.
- **Scenarios** with causal engine effects (flash crash, short squeeze, earnings beat/miss, black swan, liquidity crisis) and a reproducible **9-act demo**.
- **Real Market mode:** real quotes anchor fair value, and real headlines arrive marked LIVE and are debated automatically.
- **Made for showing people:** a phone trade dock, **Stage** mode for a TV, spectators (`?watch=1`), and provenance on every number (SIM / REAL / LIVE / PLAYER / AI / SCENARIO).
- **Built to survive:** schema-validated AI output, prompt-injection isolation, cost caps, a round watchdog, offline traders, and rate limits. It keeps playing if Claude, Finnhub or Supabase is down.

## Run it on your computer

You need [Node.js](https://nodejs.org) 20.12 or newer (22 recommended).

```bash
npm run local          # install, build, start → http://localhost:8787
```

With no keys it runs entirely on mocks. **Mock Claude** has six distinct personalities and streams realistic decisions and debates; the **mock market** makes prices and headlines; storage is in memory. Copy `.env.example` to `.env` and fill in keys to switch each part to the real thing. No code changes are needed.

`npm run dev` gives hot reload on <http://localhost:5173>. The control room (rooms, AI latency, tokens, estimated cost, errors, memory-vs-no-memory experiment) is at <http://localhost:8787/admin>.

## Show it to someone in three minutes

Open the app on a laptop and tap **Run the demo**, then **Stage**. Send the room link to a friend's phone. They trade from the bottom bar while the nine acts play out. The full script is in SETUP.md, step 6.

## Tests

```bash
npm run typecheck
npm test            # 115 unit, chaos and security tests (~10 s)
npm run test:e2e    # 9 Playwright tests: two browsers, phone dock, the full demo, spectators, chaos → recap → Legends (~2 min)
npm run soak        # 10-minute soak: memory, delta smoothness, event-loop delay
```

Everything is tested against mocks, so no keys and no spending are needed. Results from the last full run are in `tests/soak/`.

## Working on it with Claude Code

`CLAUDE.md` has the project rules. `.claude/skills/` has `pit-verify`, `pit-demo-check`, `pit-security-audit`, `pit-prompt-audit` and `pit-handoff`. `.claude/agents/` has engine, security and mobile-UX reviewers. A SessionStart hook installs dependencies in a fresh container and prints `docs/SESSION_STATE.md`; a Stop hook won't let a turn end with a failing typecheck or unit test.
