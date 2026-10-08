---
name: pit-demo-check
description: Launch The Pit on mocks and drive the 9-act demo in real browsers (phone 390x844, desktop, and a stage-mode spectator), taking screenshots at each act, then look at them and report what a first-time viewer would see. Use after UI, layout, scenario or round-flow changes.
---

1. `npm run build`, then start `PORT=8830 npx tsx server/index.ts` in the background.
2. With Playwright (`import { chromium } from './node_modules/playwright/index.mjs'`), in the scratchpad:
   - Desktop 1440x1000: open `/`, click `#demoBtn`, note the room code from the URL.
   - Phone 390x844 (`isMobile`, `hasTouch`, name in `localStorage['pit.name']`): open `/r/CODE`, buy from `#dBuy` once after Act IV.
   - Spectator 1440x900: open `/r/CODE?watch=1&stage=1`.
   - Screenshot all three every ~15 s until `#recap` is visible (about 140 s), then open a trader drawer.
   - Collect `pageerror` events and check `document.documentElement.scrollWidth <= 390` on the phone.
3. Read every screenshot. Check: act banners, the debate ribbon, opening views and "changed mind", signal bars, scored calls in the storyline, the regime and psychology changing, the halt, the recap, and no overlaps or clipped text.
4. Kill the server. Report what works, what looks wrong (with the screenshot), and the 3 highest-value fixes.
