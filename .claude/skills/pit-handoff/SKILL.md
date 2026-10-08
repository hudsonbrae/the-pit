---
name: pit-handoff
description: Write or refresh docs/SESSION_STATE.md so the next session (or a usage-limit restart) can resume The Pit without re-deriving anything. Use at the end of a work session, before a long-running task, or when asked to hand off.
---

Produce `docs/SESSION_STATE.md` from what the repository proves, not from memory:

1. `git log --oneline -15`, `git status --short`, current branch.
2. Run `npm run typecheck` and `npx vitest run` and record the pass counts you actually saw.
   Record the last Playwright and soak results only if you ran them this session (say when).
3. Write these sections, short and factual:
   - **Branch / last commit**
   - **Green right now** (gates with counts and dates)
   - **Done this session** (one line each, with commit hashes)
   - **In progress** (files touched but uncommitted, and what is left)
   - **Known issues** (with file:line where possible)
   - **Next up**, ranked, each with the first concrete step
   - **Rules that bind the next session** (from CLAUDE.md and BRIEF.md "Ask me first": nothing that costs money or needs an account without asking the owner; keys server-side; offline fallback; no real trading)
4. Keep it under ~80 lines. The SessionStart hook prints the first 40 lines, so put the most important state first.

Never paste secrets, tokens or `.env` values into the file.
