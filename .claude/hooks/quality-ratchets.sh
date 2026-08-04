#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): run the quality ratchets when a TypeScript
# source under packages/ changes, so a net-new escape hatch or an over-cap
# file is flagged at edit time — not at pre-push or CI, after the work is
# already stacked on top of it.
#
# Both scripts are pure git/fs checks (~0.3s combined), so this is cheap
# enough to run on every matching edit. Exit 2 feeds the failure output back
# to the agent; a passing run stays silent.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Only fire for TypeScript sources under packages/. dist/ output and the
# template exemption are handled inside the scripts themselves; this early
# gate just keeps non-source edits (docs, configs, scripts) instant.
if ! echo "${TOOL_INPUT:-}" | grep -qE 'packages/[^"[:space:]]*\.(ts|tsx)'; then
  exit 0
fi

failed=0
output=""
for script in check-escape-hatches.mjs check-file-length.mjs; do
  if ! result=$(node "scripts/$script" 2>&1); then
    output+="$result"$'\n\n'
    failed=1
  fi
done

if [ "$failed" -eq 1 ]; then
  {
    echo "Quality ratchet failed after this edit:"
    echo
    echo "$output"
    echo "Fix the underlying issue rather than suppressing it — both baselines only ratchet down."
  } >&2
  exit 2
fi

exit 0
