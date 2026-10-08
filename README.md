# The Pit

A live simulated stock exchange you play from your phone. Six AI traders
(Claude) read the news and trade. You and your friends trade the same order
book against them and against each other. The news is either a fictional company,
Halcyon Dynamics (HLCN), or a real US stock whose real price and real
headlines drive the simulation.

**Fake money only.** Nothing in this app places real orders, connects to a
brokerage or handles real money.

- **To get it online and send a link to a friend, follow [SETUP.md](SETUP.md).**
  It is written for someone who has never deployed anything.
- Design decisions: [DECISIONS.md](DECISIONS.md) · Market data:
  [docs/DATA.md](docs/DATA.md) · Original brief: [BRIEF.md](BRIEF.md)

## Run it on your computer

You need [Node.js](https://nodejs.org) 20.12 or newer (22 recommended).

```bash
npm install
npm run build && npm start
```

Open <http://localhost:8787>. With no keys it runs entirely on mocks:
**Mock Claude** streams realistic trader decisions, the **mock market**
makes plausible prices and headlines, and storage is in memory. To use the
real services, copy `.env.example` to `.env`, fill in the keys and restart.
No code changes are needed.

For development, `npm run dev` gives hot reload on <http://localhost:5173>.

## How it works

```
 phones / browsers  ──WebSocket──►  game server (Node + TypeScript)  ──►  Anthropic API (Claude)
   render only        intents       one engine per room, 250 ms ticks ──►  Finnhub (quotes, news)
                     ◄── deltas ──  matching, AI rounds, cost guard   ──►  Supabase (Postgres)
```

- **`server/engine.ts`**: the exchange, ported from the original
  `engine.js`. It has a limit order book with price-time priority, market
  makers, about 70 rule-based crowd bots, a hidden fair value, 5-second
  candles and circuit breakers.
- **`server/room.ts`**: one room. It ticks the engine and broadcasts a
  compact delta about 4 times a second (last price, new trades, candles, top
  8 book levels, accounts, events). It runs AI rounds: one streamed Claude
  call returning JSON Lines (desk read, six trades, two chatter lines), each
  line forwarded as it arrives, with trades executed 0.7 s apart. It falls
  back to the offline rules when Claude is unavailable or a cost cap is hit.
- **`server/prompts.ts`**: the original prompts, unchanged apart from
  taking the company as a parameter.
- **`server/market/`**: Finnhub, with one shared poller per ticker, plus a
  mock provider.
- **`server/store/`**: Supabase, or memory. The schema is in
  `supabase/schema.sql`.
- **`web/`**: the browser client (Vite + TypeScript), the original look
  ported unchanged. `original/pit.html` is the original single-file game,
  kept for reference.

## Tests

```bash
npm test            # unit tests: engine, AI rounds, multiplayer, Real Market, Supabase
npm run test:e2e    # Playwright: two browsers in one room, streaming, reconnect, Real room
npm run soak        # 10-minute soak: memory, message rate, event-loop delay
npm run typecheck
```

Everything is tested against mocks, so no keys and no spending are needed.
