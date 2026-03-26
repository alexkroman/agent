#!/usr/bin/env bash
set -euo pipefail

# Detect uncommitted changes to .api.md baselines after running api-extractor.
# This catches both accidental API changes and intentional ones that need
# their baselines committed.

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: not inside a git repository." >&2
  exit 1
}
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Run api-extractor for all packages that have it
pnpm -r run --if-present check:api 2>&1 || true

# Check if any .api.md files changed
CHANGED=$(git diff --name-only -- '**/*.api.md')

if [ -n "$CHANGED" ]; then
  echo -e "${RED}API report baselines are out of date:${NC}"
  echo "$CHANGED"
  echo ""
  echo -e "${YELLOW}This means the public API surface has changed.${NC}"
  echo "If this is intentional, commit the updated .api.md files."
  echo "If not, revert the changes that modified the public exports."
  echo ""
  echo "Changed API surfaces:"
  git diff --stat -- '**/*.api.md'
  exit 1
fi

echo -e "${GREEN}API baselines are up to date.${NC}"
