#!/usr/bin/env bash
# Claude Code SessionStart hook: a fresh cloud container has no node_modules.
# Install them (quietly) so typecheck, tests and the Stop hook work from the first turn,
# then print where the last session left off.
cd "$(dirname "$0")/../.." || exit 0
if [ ! -d node_modules ]; then npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || echo "npm install failed; run it by hand."; fi
if [ -f docs/SESSION_STATE.md ]; then
  echo "Last session state (docs/SESSION_STATE.md):"
  sed -n '1,40p' docs/SESSION_STATE.md
fi
exit 0
