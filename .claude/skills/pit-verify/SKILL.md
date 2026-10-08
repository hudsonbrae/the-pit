---
name: pit-verify
description: Run every quality gate for The Pit (typecheck, unit + chaos tests, build, Playwright e2e) and report pass/fail with the failing output. Use before committing or when asked whether the project is green.
---

Run these from the repo root, in order, and stop at the first failure to fix it:

1. `npm run typecheck`
2. `npx vitest run` (unit, chaos and security tests; ~10 s)
3. `npm run build`
4. `npx playwright test` (builds and starts its own server on :8790 with mocks; ~2 min, includes the 9-act demo)

Report a table: gate, result, duration, and for any failure the exact failing test name and assertion.
Do not mark anything as passing that you did not see pass. Never skip or weaken a test to get green.
If you changed engine behaviour, also run `SOAK_MINUTES=3 npm run soak` and report heap growth and the worst delta gap.
