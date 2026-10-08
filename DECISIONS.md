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

The brief says to measure first. The soak test (`tests/soak/last-run.json`)
shows each client receiving about 4–6 messages a second, about 1.3 KB each,
evenly spaced (p99 gap 251 ms, worst gap about 330 ms), with event-loop p99
under 50 ms. Raw `ws` is already smooth, and it has to exist anyway because
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
