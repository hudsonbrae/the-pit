# Session state — 2026-10-08

**Branch:** `claude/festive-gauss-lpi4ci` (pushed). No PR opened (none requested).

## Green right now (run this session)
- `npm run typecheck`: clean
- `npx vitest run`: 115/115 (10 files: engine, AI, multiplayer, real market, supabase, anthropic, intel, science, legends, chaos)
- `npx playwright test`: 9/9 (two browsers <50 ms tape latency, demo end-to-end, spectators, phone dock, chaos → recap → Legends → Previously on)
- `npm run soak` (10 min, 3 rooms incl. a looping demo with debates): PASSED, heap +1.1 MB, event-loop p99 11 ms, worst delta gap 286 ms
- Security red team (diff 6ee3311..0e6ee32): 1 medium + 1 break + 3 low, all fixed with regression tests

## Done this session
- Timeline + titled moments + detectors (reversal, humans vs machines, all-in)
- AI science: debate experiment (opening vs final vs control), herding by regime, twins/rivals, desk accuracy
- Tendencies + relationships into prompts; ROI, max drawdown, avg holding, measured best/worst category
- Traders: playbook / claimed edge / known flaw in prompts and drawer
- Legends (new `legends` table; memory fallback), Previously on The Pit, 9 chaos controls, admin drill-down
- Intel labels (volatility, liquidity, imbalance, human flow, news pressure); headline shown above the chart
- UX review fixes: phone landscape, lobby overflow, recap order, tap targets, prev card vs dock
- Claude Code: SessionStart hook (installs deps, prints this file), `pit-handoff` skill; docs/DEMO.md

## Known issues
- Deployed Supabase projects must re-run `supabase/schema.sql` once to get the `legends` table (records stay in memory until then; SafeStore logs the error)
- Science tallies and "Previously on" are in memory: a server restart resets them
- `server/room.ts` is ~1,400 lines (decision recorded in DECISIONS.md)
- Claude's live behaviour was only exercised through the mock; real-key costs measured earlier (~1.6¢ round, ~3.3¢ debate)

## Next up (ranked)
1. News chain reaction (a headline that moves price >3% triggers a second-order AI round; needs a chain-depth budget)
2. Persist science tallies per room config → cross-room "does debate help?" study in /admin
3. Human leaderboards by metric (return/drawdown, reaction) as Legends keys
4. Market replay with a scrubber (record deltas)
5. Ensemble trader (seventh trader following the calibrated floor consensus)

## Rules that bind the next session
Ask the owner before anything that costs money or needs an account. Keys stay server-side. Keep the offline fallback. No real trading. Push only to this branch.
