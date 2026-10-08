---
name: pit-prompt-audit
description: Review The Pit's Claude prompts and model usage (server/prompts.ts, server/ai/*, model roles in server/config.ts) for injection safety, output-format robustness, cacheability, cost and whether traders genuinely disagree. Use after editing prompts, the JSON Lines format or model configuration.
---

1. Read `server/prompts.ts`. Confirm: all instructions are in the SYSTEM_* constants (static, prompt-cached); user turns hold data only; every untrusted string goes through `quoteUntrusted` inside a tag; the SECURITY rule is present in every system prompt.
2. Check the JSON Lines contract matches `server/ai/schema.ts` exactly (field names, ranges, line counts) and `server/ai/fake.ts` still produces it (`npx vitest run tests/unit/ai.test.ts tests/unit/intel.test.ts`).
3. Check the debate prompts: phase 1 emits `view` lines only; phase 2 emits 3 `challenge` lines and 6 `trade` lines with `changed`.
4. Estimate tokens per round: system + user for a Sim room (print `SYSTEM_ROUND.length/4` and `roundUser(room.ctx(h), h).length/4` via a scratch script) and the cost with `server/costs.ts`.
5. Model roles: round/debate on the Sonnet-class model, news/ask/narrator on the Haiku-class model, all overridable in `.env`.
6. Do not expose chain of thought: UI shows only `thought` (public rationale), `signals`, `call`, `conviction`.

Report issues with file:line and a proposed diff; apply only if asked.
