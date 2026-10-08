# Session recovery — 2026-10-08

State proven from the repository (git log, test runs), not from memory.

## COMPLETED (committed on `claude/festive-gauss-lpi4ci`)
- Milestones 1–5 of BRIEF.md: authoritative engine over WebSocket; streamed AI rounds with
  persisted lessons; multiplayer rooms; Real Market mode (Finnhub); Render free-tier deploy (render.yaml, SETUP.md).
- Maximum-potential pass: scorebook (scored calls, calibration, reputation, risk budgets),
  market intel (regime with hysteresis, psychology, book signals, humans vs AI, smart money),
  storyteller + achievements, floor debate, scenarios + 9-act demo, lab, closing bell + recap +
  narrator, spectators/stage, admin, cost guard, two security passes, chaos tests.
- Product-review fixes (commit 6ee3311): demo pacing + scoreboard act, honest recap, distinct
  trader books, mobile/stage polish.
- Verified at restart: typecheck clean, 89/89 unit+chaos, 8/8 Playwright (incl. full demo),
  10-min and 20-min soaks PASSED.

## IN PROGRESS
- Nothing half-written in the tree. The working tree was clean after commit 6ee3311.

## BROKEN
- Nothing known. No failing tests.

## NOT STARTED (from "Resume, finish & go beyond")
- Event timeline, titled story moments and new detectors (reversal, humans vs AI, highest conviction).
- AI science experiment (does debate make the floor smarter?) and herding index.
- Trader relationships/tendencies from data; ROI, drawdown, human reaction time.
- "Previously on The Pit", Legends (persistent records), chaos-control buttons, admin drill-down.
- Lobby first impression, code quality pass, .claude review, final red team + UX review.

## NEXT PRIORITY
1. Timeline + titled moments (visible on every screen, cheap, uses existing state).
2. Debate experiment + tendencies (the "AI science" story; feeds recap and drawer).
3. Legends + Previously-on (persistence across sessions).
4. Chaos buttons + admin drill-down.
5. Red team, UX review, full verification, SESSION_STATE.md.
