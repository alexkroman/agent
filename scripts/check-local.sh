#!/usr/bin/env bash
set -euo pipefail

# Always run from the repo root, regardless of where this script is invoked.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: not inside a git repository." >&2
  exit 1
}
cd "$ROOT"

echo "Running check:local from $ROOT"
pnpm -r run build \
  && pnpm -r run typecheck \
  && pnpm -r run lint \
  && pnpm -r run --if-present check:api \
  && pnpm run check:syncpack \
  && vitest run
