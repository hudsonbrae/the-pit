# The Pit — build brief for Claude Code

You are taking over **The Pit**, a working browser game built by Claude in claude.ai. Your job is to turn it into a standalone web app with two new features:

1. **Real Market mode**: real stock quotes and real headlines drive the simulation.
2. **Multiplayer floor**: several humans trade the same live market from their own phones.

Read this whole brief and every file in `src/` before writing code.

## What exists today (src/)

| File | What it is |
|---|---|
| `engine.js` | Pure exchange engine, no DOM. Limit order book with price-time priority, market makers, ~70 rule-based crowd bots, a hidden fair value (`fv`/`fvTarget`) the crowd trades toward, 5-second candles, circuit breakers (10% in 30s → 6s halt, then reopen). Ticks every 250 ms. `shock(pct, speed)` moves fair value. |
| `ui.js` | Everything else: chart (canvas), order book, tape, six AI traders, newsroom, player seat, trader drawer, sound, speed control. Contains the Claude prompts: `tradePrompt()`, `brief()`, `book()`, the market wrap prompt, the "Claude writes the news" prompt, and the ask-a-trader prompt. |
| `shell.html` | Markup and CSS (design tokens at the top of `<style>`). |
| `pit.html` | The built single file: `shell.html` + `<script>` + `engine.js` (minus the `module.exports` line) + `ui.js`. Open it in a browser to see the current game. |

How Claude is called today: the page uses claude.ai's in-artifact `window.claude.use("sample")`. That does not exist outside claude.ai. **Replace it with server-side calls to the Anthropic API.**

The AI round protocol is worth keeping exactly. One streamed call returns JSON Lines:
- one `desk` line: `{impact, speed, read}`, the fair-value change;
- six `trade` lines: `{id, action, qty, order, limit, conviction, thought, lesson}`;
- two `chatter` lines: `{id, to, line}`.

The client executes trades 0.7 s apart so market makers can refill between them. An offline rule-based fallback, `offline()`, runs when Claude is unavailable. Keep it.

## Target architecture

- **Authoritative game server (Node + TypeScript).** It runs `engine.js` (port it to TS) in one process per room, ticking at 250 ms. All matching happens here. Clients never run their own engine; they render server state.
- **Realtime transport: WebSockets.** Each tick, the server broadcasts a compact delta to the room: last price, new trades, the current candle, top 8 levels of the book, and events (halt, resume, news, AI decisions, chatter). Clients send intents: place order, break news, floor check, ask trader.
- **Supabase** (the user already uses it):
  - Auth: magic link or anonymous with a display name.
  - Postgres tables: `rooms`, `players` (cash, shares, cost basis, per room), `trader_lessons` (per room and trader, so lessons persist), `news_log`, `leaderboards`.
  - Use Supabase Realtime only if it is simpler than raw WebSockets for the tick stream. Measure first: 4 messages a second per room must stay smooth.
- **Anthropic API, server-side only.** Port the prompts unchanged at first. Stream the response and forward each parsed JSON line to the room as it arrives. That streaming reveal is the core demo moment.
  - Use the current Sonnet-class model for trade rounds and the fastest Haiku-class model for chatter, headline generation and ask-a-trader. Check current model IDs in the Anthropic docs.
- **Frontend:** Vite + TypeScript. Keep the existing look exactly (fonts, tokens, layout, phone layout). Port `ui.js` render code rather than redesigning it.

## Feature 1: Real Market mode

- When a room is created, the host chooses **Sim** (fictional HLCN, as today) or **Real** (a real ticker, e.g. AAPL, NVDA, TSLA; ASX tickers only if the chosen data provider supports them reliably).
- **Quotes.** In Real mode, poll a market-data API for the real last price. Gently pull the engine's `fvTarget` toward it, so the simulated book tracks reality between headlines. Show the real price and the sim price side by side, and label it clearly: "Simulated exchange anchored to real price."
- **News.** Poll a company-news API for the ticker every few minutes. New, unseen headlines enter the newsroom automatically and go through the normal AI round, marked "LIVE" with source and time. Players can still inject their own headlines; those are marked "PLAYER".
- **Data provider.** Evaluate Finnhub, Alpha Vantage, Polygon/Massive and similar. Pick one whose free tier covers quotes plus company news, and whose terms allow showing headlines in an app. Write the choice and its rate limits into `docs/DATA.md`. Respect rate limits with caching on the server: one poll serves all rooms on the same ticker.
- **Market hours.** Outside US market hours, keep running on the last real price and say so in the UI.

## Feature 2: Multiplayer floor

- Create a room → get a short join code and a link. Friends join by link on their phones.
- Every player gets $1M of simulated cash in that room, trades on the shared book, and appears in the standings, the tape ("Brae bought 2,000") and the chart fill markers (one colour per player).
- Any player can break news. Only one AI round runs at a time. While a round is in flight, the newsroom shows who triggered it and queues or rejects a second request.
- The host can pause, change speed, or reset the room.
- If a player disconnects, their position stays. Reconnecting restores their seat.

## Hard rules

- **No real trading, ever.** Nothing in this app places real orders, connects to a brokerage, or handles real money. Fake money only.
- **Keys stay server-side** (Anthropic, data provider, Supabase service role). `.env.example` lists every variable; real `.env` files are git-ignored.
- **Cost guard.** Add a per-room limit on AI rounds per minute and a global daily cap in config. Log token usage per round.
- **Ask Brae before anything that costs money:** paid hosting, paid data plans, buying a domain. Free tiers are fine to set up. Tell him to set a monthly spend limit in the Anthropic Console before the first deploy.
- **Keep the offline fallback**, so the game still works when the API is down or the cap is hit.

## Milestones (finish and test each before the next)

1. **Server port.** `engine.ts` runs on the server for one room. One browser renders it over WebSocket and looks identical to `pit.html`.
   - Test: an engine unit test for matching, partial fills and the halt/reopen cycle; a 10-minute soak test with no memory growth.
2. **AI on the server.** Breaking news streams desk, trades and chatter to the client line by line. Lessons persist in Supabase.
   - Test: two rounds in a row; the second prompt contains the first round's lessons.
3. **Multiplayer.** Rooms, join codes, two browsers trading the same book, shared standings.
   - Test: a Playwright script with two contexts in the same room; a trade in one appears on the other's tape within 500 ms.
4. **Real Market mode.** Quote anchoring, live news ingestion, LIVE and PLAYER labels, `docs/DATA.md`.
   - Test: with a mocked data provider, a new headline triggers exactly one AI round, and duplicates are ignored.
5. **Deploy.** Free-tier hosting for the WebSocket server and the frontend, Supabase project wired up, and a README with exact run and deploy steps.
   - Ask before choosing anything paid.

## Done means

Brae opens a link on his phone, creates a Real room on a ticker, and sends the link to a friend. Both see real headlines arrive, watch six AI traders argue and trade them, trade against each other and the AI, and check the standings. It must hold up for a 20-minute session without lag or crashes.
