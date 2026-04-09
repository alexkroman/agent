#!/usr/bin/env bash
set -euo pipefail

# Parallelized check script using Turborepo.
# Usage:
#   bash scripts/check.sh          # Full CI check
#   bash scripts/check.sh --local  # Fast pre-commit gate (subset of checks)

# Always run from the repo root, regardless of where this script is invoked.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: not inside a git repository." >&2
  exit 1
}
cd "$ROOT"

MODE="${1:-full}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

LOGDIR=$(mktemp -d)
trap 'rm -rf "$LOGDIR"' EXIT

STEP_PIDS=()
STEP_LABELS=()
FAILED=0

run_step() {
  local label="$1"
  shift
  local logfile="$LOGDIR/$label.log"
  echo -e "${YELLOW}Starting:${NC} $label"
  "$@" > "$logfile" 2>&1 &
  STEP_PIDS+=($!)
  STEP_LABELS+=("$label")
}

wait_all() {
  local i
  for (( i=0; i<${#STEP_PIDS[@]}; i++ )); do
    local pid="${STEP_PIDS[$i]}"
    local label="${STEP_LABELS[$i]}"
    if wait "$pid"; then
      echo -e "${GREEN}  Passed:${NC} $label"
    else
      echo -e "${RED}  Failed:${NC} $label"
      echo "--- $label output ---"
      cat "$LOGDIR/$label.log"
      echo "--- end $label ---"
      FAILED=1
    fi
  done
  STEP_PIDS=()
  STEP_LABELS=()
}

if [ "$MODE" = "--local" ]; then
  # ── Local mode: build → typecheck + lint + publint (turbo) + syncpack ──
  echo -e "\n${YELLOW}Phase 1: Build + Checks (via turbo)${NC}"
  run_step "turbo"            pnpm exec turbo run build typecheck lint check:publint
  run_step "check:syncpack"   pnpm run check:syncpack
  run_step "check:sherif"     pnpm run check:sherif
  wait_all

  if [ "$FAILED" -ne 0 ]; then
    echo -e "\n${RED}Phase 1 failed. Skipping Phase 2.${NC}"
    exit 1
  fi

  # ── Local tests: turbo parallelizes across packages ──
  echo -e "\n${YELLOW}Phase 2: Tests (via turbo)${NC}"
  pnpm exec turbo run test || FAILED=1
else
  # ── Full CI: build → all checks (turbo) + root checks ──
  echo -e "\n${YELLOW}Phase 1: Build + Checks (via turbo)${NC}"
  run_step "turbo"            pnpm exec turbo run build typecheck lint check:publint check:attw
  run_step "check:syncpack"   pnpm run check:syncpack
  run_step "check:sherif"     pnpm run check:sherif
  run_step "check:knip"       pnpm run check:knip
  run_step "check:markdown"   pnpm run check:markdown
  wait_all

  if [ "$FAILED" -ne 0 ]; then
    echo -e "\n${RED}Phase 1 failed. Skipping Phase 2.${NC}"
    exit 1
  fi

  # ── Full CI tests: unit + integration + e2e (all via turbo) ──
  echo -e "\n${YELLOW}Phase 2: Tests (via turbo)${NC}"
  pnpm exec turbo run test check:typecheck check:integration check:e2e || FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
  echo -e "\n${RED}Some checks failed.${NC}"
  exit 1
fi

echo -e "\n${GREEN}All checks passed.${NC}"
