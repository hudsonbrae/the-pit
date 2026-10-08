#!/usr/bin/env bash
# Claude Code Stop hook: don't let a turn end with a broken build.
# Runs typecheck + unit tests only when server/web/shared/tests changed, and never
# blocks twice in a row (stop_hook_active), so it can't loop.
input="$(cat)"
if echo "$input" | grep -q '"stop_hook_active":[[:space:]]*true'; then exit 0; fi
cd "$(dirname "$0")/../.." || exit 0
changed="$(git status --porcelain -- server web shared tests 2>/dev/null)"
[ -z "$changed" ] && exit 0
if ! out="$(npm run -s typecheck 2>&1)"; then
  echo "Typecheck fails. Fix before finishing:" >&2; echo "$out" | tail -25 >&2; exit 2
fi
if ! out="$(npx vitest run --reporter=dot 2>&1)"; then
  echo "Unit tests fail. Fix before finishing:" >&2; echo "$out" | grep -vE '"ev":' | tail -30 >&2; exit 2
fi
exit 0
