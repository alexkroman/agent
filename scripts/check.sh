#!/usr/bin/env bash
set -euo pipefail

# Parallelized version of `pnpm check`.
# Build must run first (many later steps depend on build output).
# After that, independent checks run concurrently.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Track PIDs and their labels
declare -A PIDS
FAILED=0

run_step() {
  local label="$1"
  shift
  local logfile="$TMPDIR/$label.log"
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
      cat "$TMPDIR/$label.log"
      echo "--- end $label ---"
      FAILED=1
    fi
  done
  PIDS=()
}

# ── Phase 1: Build (sequential, required by later steps) ──
echo -e "\n${YELLOW}Phase 1: Build${NC}"
pnpm -r run build

# ── Phase 2: All independent checks in parallel ──
echo -e "\n${YELLOW}Phase 2: Checks (parallel)${NC}"

run_step "typecheck"        pnpm -r run typecheck
run_step "lint"             pnpm -r run lint
run_step "check:api"        pnpm -r run --if-present check:api
run_step "check:attw"       pnpm -r run --if-present check:attw
run_step "check:templates"  pnpm -r run --if-present check:templates
run_step "check:knip"       pnpm run check:knip
run_step "check:syncpack"   pnpm run check:syncpack
run_step "check:markdown"   pnpm run check:markdown

wait_all

if [ "$FAILED" -ne 0 ]; then
  echo -e "\n${RED}Phase 2 failed. Skipping Phase 3.${NC}"
  exit 1
fi

# ── Phase 3: Tests (parallel) ──
echo -e "\n${YELLOW}Phase 3: Tests (parallel)${NC}"

run_step "integration"      pnpm -r run --if-present check:integration
run_step "e2e"              pnpm -r run --if-present check:e2e
run_step "vitest"           vitest run --coverage

wait_all

if [ "$FAILED" -ne 0 ]; then
  echo -e "\n${RED}Some checks failed.${NC}"
  exit 1
fi

echo -e "\n${GREEN}All checks passed.${NC}"
