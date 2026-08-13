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
  # The mechanical half of AGENTS.md. Every rule in guard-invariants.mjs used to
  # live only as prose in that file, which is enforcement exactly as long as a
  # reviewer remembers it — and the guide is 78k characters. Pure git-grep + fs,
  # so it belongs with the other fast gates.
  pnpm run check:invariants || failed=1
  pnpm run check:file-length || failed=1
  # A test with no assertion passes whatever the code does, while counting in
  # the suite total and in coverage — indistinguishable from real coverage at
  # every level anyone looks at. Pure source scan, so it runs with the fs gates.
  pnpm run check:test-assertions || failed=1
  # A CLAUDE.md past ~150k characters is silently truncated in an agent's
  # context, so the guide is half-absent with nothing saying so. Cheap
  # read-and-count, hence up here with the other fs gates.
  pnpm run check:claude-md || failed=1
  # The guest toolchain lockfile must track the versions this checkout
  # installed: it is baked into every guest image, and a stale one silently
  # bakes a different tree than the repo tested with. Pure JSON comparison —
  # no registry — so it belongs with the fast gates.
  pnpm run check:guest-toolchain || failed=1
  # The agent-authoring guide also ships INSIDE the @alexkroman1/aai tarball, so
  # a project that has updated its SDK can read guidance matching the version it
  # actually resolved rather than the copy `aai init` froze in. Same silent-
  # staleness shape as the toolchain lockfile above, hence the same treatment:
  # a committed copy plus a comparison. Pure file read.
  pnpm run check:agent-guide || failed=1
  # The scaffold's package.json is the third committed copy in this shape, and
  # the only one that SHIPS: it cannot say `catalog:`, so every catalogued bump
  # has to be applied to it a second time. Nothing enforced that — the sync
  # script ran only from `pnpm version`, unchecked, during a release — and the
  # catalog migration had already broken it into writing the literal
  # `"catalog:"` into a manifest npm cannot resolve. Pure file comparison.
  pnpm run check:scaffold || failed=1
  # Structural conventions (konsistent.json): the shapes Biome and tsc cannot
  # see because none of them is wrong WITHIN a file — a provider module that
  # exports four of its five symbols, a *-barrel.ts that grew a local
  # declaration, a package importing across a dependency-graph boundary the
  # architecture forbids. Pure fs + AST scan over ~600 files in ~1s, no build,
  # hence up here with the other fast gates.
  pnpm run check:konsistent || failed=1
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
  #
  # `test:coverage` rather than `test`, because CI's test matrix runs
  # test:coverage and the per-package floors in each vitest.config.ts are what
  # it gates on. Running plain `test` here made a coverage-floor failure
  # STRUCTURALLY invisible until CI: a new module can be green in every suite
  # and still take its package under a floor, which is a red `test (<pkg>)`
  # against an all-passing local run — the same green-locally/red-in-CI shape
  # this repo has already been bitten by twice (the root tsconfig missing from
  # turbo's inputs, and snapshot `update: "none"`). It is close to free:
  # measured on aai-ui, 17.0s → 17.9s.
  if ! pnpm exec turbo run \
    build typecheck lint check:publint \
    check:syncpack check:sherif check:knip \
    lint:scripts \
    test:coverage \
    --continue; then
    echo -e "\n${RED}Some checks failed.${NC}"
    exit 1
  fi
  pnpm run check:publish-names
  # After build, and it PACKS: `catalog:` / `workspace:` are pnpm-only
  # protocols that pnpm rewrites when it makes a tarball, and that rewrite is
  # the only thing between the catalog and a release that installs for nobody.
  # publint reads the SOURCE manifest, so it cannot see this.
  pnpm run check:publish-protocols || exit 1
  # Also after build: it reads the emitted dist/*.d.ts. A committed API report
  # per published entry point, so a SIGNATURE change is a reviewable diff —
  # exports.test.ts pins names, publint/attw check packaging, and neither sees
  # a widened parameter or a newly optional field.
  pnpm run check:api-report || exit 1
  # Immediately after, and in that order on purpose: the capability contracts
  # read the authoring surface out of the committed reports, so a stale report
  # would be answered here as though it were current. This is the gate that
  # turns "the signature moved" into "and it is a major, and here is the frozen
  # example proving epoch N still compiles".
  pnpm run check:api-contracts || exit 1
  # After build on purpose: the scaffold tsconfig has no `@dev/source`
  # condition, so templates resolve the PUBLISHED types here, exactly as a
  # scaffolded project does. Doc examples compile under the same config, so
  # the same ordering applies.
  pnpm run check:template-types || exit 1
  pnpm run check:doc-examples || exit 1
  # Say what this run did NOT cover. `--local` is a subset by design, but a
  # green subset reads as a green branch — and the gates left out are exactly
  # the ones whose failures are hardest to guess from a diff (a broken
  # `{@link}` fails `docs`, which treats warnings as errors; a route that only
  # exists under `aai dev` fails `check:integration`). Naming them is the
  # difference between choosing to skip a gate and forgetting it exists.
  echo -e "\n${YELLOW}Not run by --local (CI will):${NC}"
  echo "  check:attw          published export types"
  echo "  check:markdown      markdownlint over every .md"
  echo "  check:integration   real subsystems — HTTP, WebSockets, Postgres (pnpm test:pg)"
  echo "  check:e2e           full process spawn + Playwright"
  echo "  docs                TypeDoc, with treatWarningsAsErrors"
  echo -e "  Run \`pnpm check\` for all of them.\n"
else
  echo -e "\n${YELLOW}Running full CI checks (via turbo)${NC}"
  if ! pnpm exec turbo run \
    build typecheck lint check:publint check:attw \
    check:syncpack check:sherif check:knip check:markdown \
    lint:scripts \
    test:coverage check:integration docs \
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
  #
  # `--concurrency=1` is the same rule stated inside the invocation: nothing
  # may run beside the e2e task, not even a sibling turbo task that this
  # invocation pulls in itself. `build` is already a cache hit by the time we
  # get here (the combined run above built everything), so serializing costs
  # nothing and the flag matches `pnpm test:e2e` and the CI e2e job.
  if ! pnpm exec turbo run check:e2e --concurrency=1; then
    echo -e "\n${RED}Some checks failed.${NC}"
    exit 1
  fi
  pnpm run check:publish-names
  # After build, and it PACKS: `catalog:` / `workspace:` are pnpm-only
  # protocols that pnpm rewrites when it makes a tarball, and that rewrite is
  # the only thing between the catalog and a release that installs for nobody.
  # publint reads the SOURCE manifest, so it cannot see this.
  pnpm run check:publish-protocols || exit 1
  # Also after build: it reads the emitted dist/*.d.ts. A committed API report
  # per published entry point, so a SIGNATURE change is a reviewable diff —
  # exports.test.ts pins names, publint/attw check packaging, and neither sees
  # a widened parameter or a newly optional field.
  pnpm run check:api-report || exit 1
  # Immediately after, and in that order on purpose: the capability contracts
  # read the authoring surface out of the committed reports, so a stale report
  # would be answered here as though it were current. This is the gate that
  # turns "the signature moved" into "and it is a major, and here is the frozen
  # example proving epoch N still compiles".
  pnpm run check:api-contracts || exit 1
  pnpm run check:template-types || exit 1
  pnpm run check:doc-examples || exit 1
fi

if [ "$RATCHET_STATUS" -ne 0 ]; then
  echo -e "\n${RED}Quality ratchet(s) failed.${NC}"
  exit 1
fi

echo -e "\n${GREEN}All checks passed.${NC}"
