#!/usr/bin/env bash
set -euo pipefail

# Parallelized check script using Turborepo.
#
# All tasks run in a single turbo invocation for maximum parallelism.
# Turbo handles the dependency graph:
#   - build, lint, test, syncpack, sherif start immediately (no deps)
#   - typecheck, publint, attw wait for build to finish
#   - --continue: independent tasks keep running when one fails
#
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

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ "$MODE" = "--local" ]; then
  echo -e "\n${YELLOW}Running local checks (via turbo)${NC}"
  if ! pnpm exec turbo run \
    build typecheck lint check:publint \
    check:syncpack check:sherif \
    test \
    --continue; then
    echo -e "\n${RED}Some checks failed.${NC}"
    exit 1
  fi
  pnpm run check:publish-names
else
  echo -e "\n${YELLOW}Running full CI checks (via turbo)${NC}"
  if ! pnpm exec turbo run \
    build typecheck lint check:publint check:attw \
    check:syncpack check:sherif check:knip check:markdown \
    test check:typecheck check:integration check:e2e \
    --continue; then
    echo -e "\n${RED}Some checks failed.${NC}"
    exit 1
  fi
  pnpm run check:publish-names
fi

echo -e "\n${GREEN}All checks passed.${NC}"
