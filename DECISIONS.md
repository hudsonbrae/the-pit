# Decisions

Choices made while building The Pit from `BRIEF.md`, and why. Each one can be
changed without touching the rest.

## Source

- **Where the original came from.** The repo had no `src/`, so the source
  is the published claude.ai artifact the brief points to. It is saved
  unchanged as `original/pit.html` (the built single file: shell + engine +
  UI). Everything was ported from that file.

## Architecture

- **One Node process, one URL.** The game server serves both the built
  frontend and the WebSocket (`/ws`) from the same origin. That means one
  free service to deploy, no CORS, and the WebSocket URL is simply the
  page's own host. The brief's "hosting for the WebSocket server and the
  frontend" is met by a single Render web service.
- **Server runs TypeScript directly with `tsx`.** There is no server build
  step, so there are fewer things to go wrong on a first deploy. `tsx` is a
  runtime dependency because of this. Only the frontend is built (Vite).
- **Engine port is line-for-line.** `server/engine.ts` keeps the original
  logic and constants. The changes are: a class instead of a singleton (one
  per room); injectable randomness, so the tests are deterministic; a start
  price; an optional real-price anchor; and the event queue is drained each
  frame, because the original's `S.events` grew forever (fine for one
  browser tab, a leak on a server).
- **Rooms freeze when empty.** A room with nobody connected stops ticking
  and stops running LIVE rounds, which saves CPU and AI cost. It resumes when
  someone joins. After 2 hours empty it is unloaded from memory, and it is
  rebuilt from the database if someone opens the link again.
- **Cost basis is tracked per fill on the server** (from the `onTrade`
  hook), not per order as in the original. That keeps a player's average
  cost right even for orders queued during a halt and released at the
  reopen, which the original missed.
- **Delta cadence.** One delta per 250 ms frame, plus an extra flush right
  after a player's order or an AI trader's execution, so fills show at once.
  The tape renders on every delta that brings trades, and the book and
  standings every second frame, as the original did.
- **Measured CPU cost:** about 0.06 ms per room frame (2,400 frames, i.e. 10
  minutes of play, in 150 ms). Render's free instance (0.1 CPU) can run
  dozens of rooms.

## Transport: raw WebSockets, not Supabase Realtime

The brief says to measure first. In the 10-minute soak test
(`tests/soak/last-run.json`), 5 clients in 2 rooms each received 5.5–6.2
messages a second (4 tick deltas plus instant flushes after fills), about
1.3 KB each, evenly spaced: p99 gap 251 ms, worst gap 279 ms. The
event-loop p99 was 10.8 ms. Heap went from 20.3 to 21.3 MB over 8 minutes
after warm-up (0.12 MB/min) while 38 AI rounds ran. Raw `ws` is already smooth, and it has to exist anyway because
the server is authoritative and must receive intents (orders, news, ask).
Supabase Realtime would add a hop through Supabase for every tick, plus a
second channel for intents. On the free plan its monthly message quota
would also run out quickly: one 20-minute game with two players is about
10,000 tick messages. So Supabase is used for what it's good at here:
Postgres.

## Identity: anonymous with a display name

The brief allows "magic link or anonymous with a display name". I chose
anonymous **without Supabase Auth**. The browser keeps a random token in
`localStorage` and sends it with the join, and the server maps
(room, token) to a seat. That gives reconnect and "same seat after reload"
with no email step for a friend opening a link on their phone, and no auth
settings to configure in Supabase. The trade-off: a seat lives in one
browser. Switching phones means a new seat. Tokens are never broadcast;
other players see only `p1`, `p2`, and so on.

## Rooms and players

- **Join codes are 5 letters with no I or O**, so they are easy to read
  aloud. A link looks like `/r/ABCDE`.
- **Host** is the room creator. Only the host can pause, change speed or
  reset. Host status doesn't transfer. If the host leaves, the room keeps
  running at its current speed.
- **Player colours:** the first player gets the original "You" white; the
  others get distinct colours that don't clash with the six traders. The
  colours show in the standings, tape, book squares and chart fill markers.
  On your own screen you're still "You".
- **One AI round at a time.** Player requests made during a round are
  **rejected** with "A round is already in flight (Brae)". The newsroom shows
  "triggered by Brae" to everyone. LIVE headlines are **queued** instead,
  keeping the three newest, because nobody is there to press the button
  again.
- **Reset** saves a standings snapshot to `leaderboards`, puts everyone
  back to $1M and rebuilds the market. The traders' lessons are kept.
- **Limits:** 12 players per room, 50 rooms per server, 8 orders a second
  per player, 220-character headlines, 20-character names. All of these can
  be changed with environment variables where it matters.

## AI

- **Models:** `claude-sonnet-5-5` for trade rounds, `claude-haiku-5-5` for
  "Claude writes the news", the market wrap and ask-a-trader, as the
  brief asks. These are the current Sonnet and Haiku IDs per Anthropic's
  docs. Both can be changed in `.env` (`AI_MODEL_ROUND`, `AI_MODEL_FAST`).
- **Effort instead of a bigger model for "Deep think".** The original
  toggled a "quick" or "default" tier. Here, Deep think keeps Sonnet but
  raises its effort from `low` to `high`, so it thinks longer before the
  first line streams. Rounds default to `low` effort so the desk line
  arrives fast, which is the core demo moment.
- **Prompts are the original text.** The only change is that the company
  (description, ticker, short name) is a parameter. In a Sim room the
  prompts are byte-for-byte the original. Real rooms add one line to the
  market brief with the real price and whether the US market is open.
- **The mock is selected automatically** when `ANTHROPIC_API_KEY` is
  empty. It reads the same prompts and streams realistic JSON Lines (desk,
  six trades with thoughts and lessons, two chatter lines) in small chunks
  with a "thinking" pause first. The header says "Mock Claude (no API key)",
  so nobody mistakes it for the real thing.
- **Offline fallback kept** exactly as in the original (`server/offline.ts`).
  It runs when there's no key, on an API error, on a refusal, when the key
  is rejected (then every room switches to offline and the header says so),
  and when a cost cap is hit.
- **Refusal fallback.** Anthropic offers a server-side model fallback for
  refusals (a beta flag). I didn't enable it: it can't be tested without a
  key, and a refusal on a game prompt is rare. The game's own offline
  traders already handle `stop_reason: refusal`. Turning it on later is a
  small change in `server/ai/anthropic.ts`.
- **Cost guard** (`server/costguard.ts`): `AI_ROUNDS_PER_MIN_PER_ROOM` (3),
  `AI_DAILY_ROUND_CAP` (200 trade rounds per UTC day, across all rooms) and
  `AI_DAILY_SMALL_CAP` (400 Haiku calls). Every Claude call logs one JSON line
  with tokens in and out, the model and the duration (`"ev":"ai_usage"`).
  Each headline's row in `news_log` stores its tokens too.
  `/api/health` shows the day's totals.
- **Market wrap and ask-a-trader are private** to the player who asked;
  they stream only to that player. They don't block the newsroom.

## Real Market mode

See [docs/DATA.md](docs/DATA.md) for the provider evaluation, endpoints,
rate limits and dedupe rules. The short version:

- **Finnhub free plan**: real-time US quotes, company news, profile and
  market status, at 60 calls a minute.
- **One poller per ticker** is shared by all rooms; the server holds itself
  to 50 calls a minute.
- **Anchoring:** fair value is pulled 0.2% per tick toward the real price
  (about a 2-minute half-life). The real and simulated prices show side by
  side, labelled "Simulated exchange anchored to real price".
- **US tickers only.** Finnhub's free plan doesn't cover ASX quotes
  reliably.
- **Share counts stay as in the original** (traders start with 4,000
  shares and $600k; 6,000 shares per round; ±12,000 position limit;
  players start with $1M). On a $900 stock that is a bigger dollar
  position than on HLCN at $100. It's a game, and keeping the prompt
  numbers unchanged was worth more than per-ticker scaling.
- **A new Real room opens on the latest real headline** if it's less than
  24 hours old, so there's something happening immediately. After that,
  only new headlines trigger rounds.

## Persistence (Supabase)

- Tables as the brief lists them: `rooms`, `players`, `trader_lessons`,
  `news_log` and `leaderboards` (`supabase/schema.sql`). Row Level
  Security is on with no policies, so only the server (secret key) can read
  or write them.
- **Writes are best-effort.** A database error is logged and the game
  carries on from memory. Positions are saved every 5 seconds and on
  disconnect. Lessons are saved the moment they're written.
- **Without Supabase keys** the server uses an in-memory store, so
  everything works until the server restarts.
- **The AI traders' cash and positions aren't persisted.** They belong to
  one market session. When a room is rebuilt (after a restart or a Render
  wake-up) the market and the traders start fresh, while players keep their
  cash and shares and the traders keep their lessons.
- Accepts Supabase's new `sb_secret_…` key (`SUPABASE_SECRET_KEY`) or the
  legacy `service_role` key (`SUPABASE_SERVICE_ROLE_KEY`), because Supabase
  is phasing the legacy keys out.

## Hosting

- **Render free web service.** It supports WebSockets, deploys from GitHub
  with a `render.yaml` blueprint, and HTTP requests and WebSocket messages
  both count as activity. The trade-offs: it sleeps after 15 minutes idle
  (about 1 minute to wake), and it has 512 MB RAM and 0.1 CPU, which is
  plenty (see the CPU figure above). Rejected alternatives: Fly.io and
  Railway offer trial credit rather than a standing free tier for new
  accounts, and Vercel and Netlify don't host long-lived WebSocket servers.
- **Region: Singapore**, the closest Render region to Australia. The
  Supabase project should go in Singapore too, so the database calls stay
  short.
- **Nothing paid was set up or chosen.** Render may ask for a card to verify
  the account; that is the user's call when signing up.

## Look

- `web/src/style.css` is the original CSS verbatim, followed by a clearly
  marked block of additions that use the same tokens. The additions cover
  the lobby, the real-price chip, the LIVE and PLAYER tags, the pause notice,
  and the `body{margin:0}` that the claude.ai page wrapper used to provide.
- Layout, fonts (Big Shoulders Display, IBM Plex Sans and Mono), colours
  and both breakpoints (1100 px and 760 px) are unchanged. Desktop and phone
  screenshots were compared against the original side by side.
- The legend says "▲▼ fills" instead of "▲▼ AI fills", because players' fills
  are drawn too.

## Process

- All four features were built before the tests were written. The commits
  were then made milestone by milestone, each when that milestone's tests
  passed. The Milestone 1 commit therefore already contains code used by
  later milestones.

---

# Maximum-potential pass

The audit and scoring are in `docs/MAXIMUM_POTENTIAL_AUDIT.md`. Three
specialist reviews ran in parallel before building (security, engine
microstructure, mobile/demo UX) and two after (a security re-review and a
fresh-eyes product review). Their measured findings drove the choices below.

| Decision | Alternatives | Why | Consequences |
|---|---|---|---|
| **The AI proposes, the engine decides**: every model line goes through `server/ai/schema.ts` (ids, actions, ranges, risk budget, position limits, text cleaning; objects never coerced) | Trust and clamp field by field (as before) | One choke point. A `{"toString":0}` field could crash the process before | Malformed lines are dropped and the offline rules fill the gaps; tests prove that even a fully obedient model stays inside the rules |
| **System/user split for prompts**: rules, personas and format in a static system prompt (prompt-cached); data only in the user turn; untrusted text in `<headline>`/`<question>`/`<lesson>`/`<player>` tags with angle brackets neutralised | Keep the original single prompt, unchanged | The original pasted player text inside the instructions, which invited prompt injection. Caching the static part also cuts cost | Sim prompts are no longer byte-for-byte the original, though the wording is largely kept |
| **Calls scored after 60 simulated seconds** (flat band ±0.4%) | Score on the next round; score on P&L only | Fixed horizon and independent of play speed, it measures prediction separately from trading luck | Calibration, streaks, the Oracle and risk budgets all come from real outcomes. Scores are noisy for the first few calls, so reputation uses shrunk accuracy ((c+2)/(n+4)) and the Oracle needs 5+ calls |
| **Risk budgets enforced by the engine** (halved on a 3-wrong streak, ×0.6 in a 4% drawdown, halved for a cautious desk) | Prompt-only advice | Traders "evolve" in a way the engine guarantees, not just in prose | A cold trader visibly trades smaller ("risk cut to 3,000") |
| **Floor debate = two calls** (views, then challenges + final decisions), automatic for LIVE news, optional for players and scenarios | Six separate trader calls; three-call debate | Legible drama at twice the cost of one round, not seven times. Phase-2 failure falls back to the opening views | A debate counts as 2 against every cap |
| **Intel from observable state only**, with thresholds measured on the engine (calm 1-min RV ≈ 125 bps, spread p90 ≈ 17 bps, \|OFI\| p99 ≈ 0.6) | Read the hidden fair value; hand-tuned thresholds | Showing fair value would leak the game. Measured thresholds make "PANIC" mean something | Regime, psychology and book signals can be checked against the tape |
| **Engine changes adopted from measurement**: stress-aware dealer spreads with a 0.8% dead-band, inventory cap 1,500, `fvK` decay, momentum gate 0.4% → 0.8%, noise traders 0.08 → 0.10 | My first version: vol-ratio stress with no dead-band | The reviewer measured that no dead-band doubles calm volatility through feedback | Calm is calmer, shocks drain liquidity visibly, and "fast" news no longer leaves the room fast forever |
| **No event bus** | A typed internal bus | The room already has the few hook points (fill, round end, halt, frame). Direct calls to the scorebook, intel and storyteller are easier to follow | If a fourth subscriber appears, add a bus then |
| **Scenarios run in Sim rooms only** | Allow them in Real rooms | Fictional events must never mix with a real price feed (data integrity) | Real rooms get debates and intel, but no scripted shocks |
| **Spectators** (`?watch=1`) take no seat and send no intents | Treat them as players with zero cash | Keeps standings honest and lets a TV join without a name | Up to 50 per room; counted in "watching" |
| **Stage mode is a CSS mode** (`?stage=1` or the Stage pill) | A separate page | Same state and code; it only hides controls and scales type | No QR code yet: that needs a dependency (roadmap) |
| **Closing bell** replaces sim-clock session phases | Pre-market / midday / close tied to the sim clock | At 1× a 20-minute game never leaves the open, so phases would be fake. A host-rung bell gives a real arc | The Daily Wrap is factual even offline; Claude adds the narration when connected |
| **Tokens are hashed (SHA-256) before storage** | Store raw tokens | A database leak can't be replayed into seats | Rows from before this change don't match. No deployed data existed |
| **Per-socket token bucket, per-IP socket and room-creation limits, Origin check, CSP** | Rely on the host's proxy | Each crash or abuse path from the security review was reproduced and now has a test | Behind Render's proxy the client IP is the last `X-Forwarded-For` entry; the admin view without a token is loopback-only and refuses proxied requests |
| **Persisted daily AI usage** (`ai_usage_daily`) | In-memory counters | A crash or restart could reset the daily cap | One small upsert every few seconds while AI is in use |
| **Admin page at `/admin`**: loopback, or `?token=ADMIN_TOKEN` | A separate dashboard service | Observability without infrastructure | Set `ADMIN_TOKEN` in Render to use it in production |
| **Cost estimates from a price table** (`server/costs.ts`, overridable with `AI_PRICES`) | Anthropic usage API | No admin key needed; good enough to steer | Cached input tokens are counted at full price, so estimates run slightly high |
| **Claude Code dev system**: 4 skills (`pit-verify`, `pit-demo-check`, `pit-security-audit`, `pit-prompt-audit`), 3 agents (engine, security, mobile-UX reviewers), a Stop hook (typecheck + unit tests, only when code changed, never blocks twice in a row) | No tooling, or a skill per idea | Each one is a workflow actually used in this pass | The Stop hook adds about 10 s to a turn that changed code |
| **Second security pass** (after a re-review of the new code): rooms nobody joins are swept after 5 min; room restores and WebSocket joins are rate-limited per IP; `POST /api/rooms` needs JSON from this origin; deep think counts 3 units; each room creator (IP) gets a daily share (`AI_OWNER_DAILY_ROUND_CAP`); Haiku calls are capped per room; the narrator runs once per session; `X-Forwarded-For` is trusted only behind a proxy (auto on Render); IPv6 keyed by /64; limiters evict expired entries instead of clearing; the admin token is sent as a header (from the URL fragment) and compared in constant time; invisible and bidi characters are stripped from names | Accept the residual risk | Each item was a concrete, cheap attack: filling the server, draining the day's AI budget, or dodging per-IP limits | A host can still burn their own room's daily share; the global caps and the Anthropic monthly limit bound the worst case |
