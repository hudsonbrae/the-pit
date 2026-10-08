---
name: pit-security-audit
description: Security audit checklist for The Pit's attack surface (WebSocket intents, HTTP API, prompts, model output, XSS, admin, costs, DoS) with targeted proofs. Use after changing server/app.ts, server/room.ts, the protocol, prompts or any innerHTML in the client.
---

Work through each item; for anything suspicious write a throwaway proof in the scratchpad and run it against real code.

1. **Crash paths**: every `ws.on`/HTTP handler is wrapped; no `void promise` without `.catch`; `JSON.parse`, `decodeURIComponent`, `String(obj)` on untrusted values. Try: oversized frame, invalid UTF-8, `GET /%E0%A4%A`, `{"toString":0}` in every message field.
2. **Model output**: everything passes `server/ai/schema.ts`; quantities within risk budget and ±12,000 position; unknown trader ids dropped; impacts clamped.
3. **Prompt injection**: untrusted text only via `quoteUntrusted` inside tags; the system prompt holds all instructions. Test a headline that closes the tag and issues orders.
4. **XSS**: every `innerHTML` in `web/src/main.ts` and `server/admin.ts` escapes untrusted strings with `esc`; hrefs are http(s) only; colours come from the server palette.
5. **Auth/abuse**: host-only actions, spectators can't act, token hashing, per-socket bucket, per-IP sockets and room creation, Origin check, admin token (and that X-Forwarded-For can't fake loopback).
6. **Cost**: debates count 2 units; per-room per-minute and daily caps; global daily cap persisted; ask/wrap/news cooldowns; deep think host-only.
7. **Memory**: every per-room and per-IP map/array is capped.
8. **Secrets**: `git grep -nE "sk-ant-|sb_secret_|eyJhbGci"` finds nothing; no key in `dist/`.

Report findings by severity with file:line, attack, and fix. Run `npx vitest run tests/unit/chaos.test.ts tests/unit/intel.test.ts` at the end.
