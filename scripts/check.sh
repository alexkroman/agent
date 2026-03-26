#!/usr/bin/env bash
set -euo pipefail

# Parallelized check script.
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

# Use pnpm --filter to only run on changed packages when possible.
# Falls back to -r (all packages) when on main or origin/main is unavailable.
if git rev-parse --verify origin/main &>/dev/null \
   && [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  PNPM_FILTER='--filter ...[origin/main]'
  echo "Using pnpm filter: $PNPM_FILTER"
else
  PNPM_FILTER='-r'
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

LOGDIR=$(mktemp -d)
trap 'rm -rf "$LOGDIR"' EXIT

declare -A PIDS
FAILED=0

run_step() {
  local label="$1"
  shift
  local logfile="$LOGDIR/$label.log"
  echo -e "${YELLOW}Starting:${NC} $label"
  "$@" > "$logfile" 2>&1 &
  PIDS[$!]="$label"
}

wait_all() {
  for pid in "${!PIDS[@]}"; do
    local label="${PIDS[$pid]}"
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
  PIDS=()
}

# ── Phase 1: Build (sequential, required by later steps) ──
echo -e "\n${YELLOW}Phase 1: Build${NC}"
pnpm -r run build

# ── Phase 2: Checks (parallel) ──
echo -e "\n${YELLOW}Phase 2: Checks (parallel)${NC}"

run_step "typecheck"        pnpm $PNPM_FILTER run typecheck
run_step "lint"             pnpm $PNPM_FILTER run lint
run_step "check:api"        pnpm $PNPM_FILTER run --if-present check:api
run_step "check:syncpack"   pnpm run check:syncpack

if [ "$MODE" != "--local" ]; then
  run_step "check:attw"       pnpm $PNPM_FILTER run --if-present check:attw
  run_step "check:templates"  pnpm $PNPM_FILTER run --if-present check:templates
  run_step "check:knip"       pnpm run check:knip
  run_step "check:markdown"   pnpm run check:markdown
fi

wait_all

if [ "$FAILED" -ne 0 ]; then
  echo -e "\n${RED}Phase 2 failed. Skipping Phase 3.${NC}"
  exit 1
fi

# ── Phase 3: Tests (parallel) ──
echo -e "\n${YELLOW}Phase 3: Tests (parallel)${NC}"

if [ "$MODE" = "--local" ]; then
  run_step "vitest"           vitest run
else
  run_step "integration"      pnpm $PNPM_FILTER run --if-present check:integration
  run_step "e2e"              pnpm $PNPM_FILTER run --if-present check:e2e
  run_step "vitest"           vitest run --coverage
fi

wait_all

if [ "$FAILED" -ne 0 ]; then
  echo -e "\n${RED}Some checks failed.${NC}"
  exit 1
fi

echo -e "\n${GREEN}All checks passed.${NC}"
