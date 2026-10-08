# The Pit — project instructions

A multiplayer simulated trading floor: six Claude-powered AI traders and human players trade one
order book. Fake money only. See README.md (overview), docs/ARCHITECTURE.md (system map),
DECISIONS.md (why things are the way they are), docs/ROADMAP.md (what's next).

## Hard rules
- **No real trading, ever.** No brokerage, no real orders, no real money. Real market data is an input only.
- **Keys stay server-side.** Never send a key to the browser, a log line or git. `.env` is git-ignored.
- **Ask the owner before anything that costs money** (paid hosting, paid data plans, domains) or needs them to create an account.
- **Keep the offline fallback working**: the game must run with no keys, a dead API, a dead database or dead market data.
- **The AI proposes, the engine decides.** All model output goes through `server/ai/schema.ts`. Untrusted text (player headlines, names, questions, LIVE news, lessons) goes into prompts only inside tagged data blocks via `quoteUntrusted`.
- **Everything shown is derived from real state.** No decorative numbers. Label provenance: SIM / REAL / LIVE / PLAYER / AI / SCENARIO.
- Keep the original look (tokens and fonts in `web/src/style.css`); don't restyle into a generic dashboard.

## Commands
- `npm run local`: install, build, start on :8787 (mocks when keys are absent)
- `npm run dev`: server + Vite with hot reload on :5173
- `npm run typecheck` · `npm test` (unit + chaos) · `npm run test:e2e` (Playwright) · `npm run soak` (10 min)
- Admin view: http://localhost:8787/admin (loopback, or `?token=ADMIN_TOKEN`)

## Where things live
- `server/engine.ts` exchange · `server/room.ts` one room (rounds, debate, scoring, scenarios) · `server/intel/` stats, market intel, stories
- `server/prompts.ts` system/user prompts · `server/ai/` LLM clients (real + mock) and the output schema
- `server/market/` data providers · `server/store/` Supabase/memory · `web/src/main.ts` the client

## Workflow
Use the project skills: `/pit-verify` before committing, `/pit-demo-check` after UI changes,
`/pit-security-audit` and `/pit-prompt-audit` after touching inputs, prompts or the protocol.
A Stop hook runs typecheck + unit tests when server/web/shared/tests changed.
