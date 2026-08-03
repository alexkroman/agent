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

# Turbo defaults to 10 concurrent tasks, but each task spawns its own worker
# pool (vitest forks/threads), so on a small machine that oversubscribes the
# CPUs several times over. The visible symptom was flaky failures rather than
# slowness: aai-server's credential tests run PBKDF2 at 600k iterations, which
# stretches from ~300ms to ~750ms per hash under contention and pushed whole
# tests past their timeout. Leave room for each task's internal parallelism.
# An explicit TURBO_CONCURRENCY still wins.
if [ -z "${TURBO_CONCURRENCY:-}" ]; then
  CORES="$( (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null) || echo 4)"
  TURBO_CONCURRENCY="$(( CORES / 2 > 2 ? CORES / 2 : 2 ))"
  export TURBO_CONCURRENCY
fi

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Quality ratchets that aren't part of the turbo graph. These are fast,
# pure-git/fs gates that hold the line on technical debt: they fail when a
# branch introduces net-new escape hatches or oversized files. Run them up
# front so a debt regression fails fast before the slower turbo tasks.
run_ratchets() {
  local failed=0
  pnpm run check:hatches || failed=1
  pnpm run check:file-length || failed=1
  return "$failed"
}

RATCHET_STATUS=0
run_ratchets || RATCHET_STATUS=1

if [ "$MODE" = "--local" ]; then
  echo -e "\n${YELLOW}Running local checks (via turbo)${NC}"
  # check:knip is in the local subset despite being a "full CI" style gate:
  # it needs no build, costs ~2s, and it is the only thing that catches a
  # dependency orphaned by a deletion. That failure mode is invisible while
  # you work (you are thinking about what to remove, not what removal
  # strands) and expensive to discover at push time.
  if ! pnpm exec turbo run \
    build typecheck lint check:publint \
    check:syncpack check:sherif check:knip \
    test \
    --continue; then
    echo -e "\n${RED}Some checks failed.${NC}"
    exit 1
  fi
  pnpm run check:publish-names
  # After build on purpose: the scaffold tsconfig has no `@dev/source`
  # condition, so templates resolve the PUBLISHED types here, exactly as a
  # scaffolded project does.
  pnpm run check:template-types || exit 1
else
  echo -e "\n${YELLOW}Running full CI checks (via turbo)${NC}"
  if ! pnpm exec turbo run \
    build typecheck lint check:publint check:attw \
    check:syncpack check:sherif check:knip check:markdown \
    test check:typecheck check:integration docs \
    --continue; then
    echo -e "\n${RED}Some checks failed.${NC}"
    exit 1
  fi
  # check:e2e runs ALONE, in its own invocation after everything else.
  #
  # It is not a well-behaved sibling: the mock registry rebuilds and
  # republishes every publishable package from the live workspace
  # (`_mock-registry.ts`), which truncates `packages/aai-ui/dist` and
  # `packages/aai/dist` and briefly rewrites each package.json to a unique
  # version. Run concurrently — which is what one combined `turbo run test
  # check:e2e` does, since neither declares an order against the other —
  # that rewrites shared artifacts underneath sibling packages' tests while
  # they read them. `aai-guest`'s toolchainModules suite asserts
  # `@alexkroman1/aai-cli/dist/templates/**` exists, and aai-server's
  # orchestrator tests read `aai-ui/dist/default-client`; both fail for the
  # length of the window, with errors that name a missing file and point
  # nowhere near the e2e run that removed it.
  #
  # No `dependsOn` expresses this — turbo orders tasks against a package's
  # own dependency graph, and this is a whole-workspace side effect. CI never
  # hit it because check.yml already gives e2e its own job; the exposure was
  # local `pnpm check` (i.e. pre-push) whenever check:e2e was a cache MISS,
  # which is every fresh worktree and every first run after a clone.
  if ! pnpm exec turbo run check:e2e; then
    echo -e "\n${RED}Some checks failed.${NC}"
    exit 1
  fi
  pnpm run check:publish-names
  pnpm run check:template-types || exit 1
fi

if [ "$RATCHET_STATUS" -ne 0 ]; then
  echo -e "\n${RED}Quality ratchet(s) failed.${NC}"
  exit 1
fi

echo -e "\n${GREEN}All checks passed.${NC}"
