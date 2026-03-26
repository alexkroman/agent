# Multi-Agent Velocity Recommendations

**Status:** complete
**Created:** 2026-03-26
**Method:** Condorcet voting across 10 simulated engineer personas

## Process

Ten AI agents, each representing a different engineering personality, independently
explored the AAI codebase and generated 10-15 recommendations for improving
velocity and iteration speed. Their individual recommendations were normalized
into 15 canonical candidates, then each agent ranked all 15 candidates. Condorcet
pairwise voting was used to produce the final consensus ranking.

### Engineer Personas

| # | Name | Perspective |
|---|------|------------|
| 1 | Maya | Pragmatic senior — simplicity, reducing toil |
| 2 | Carlos | DevOps/infra — CI/CD, caching, automation |
| 3 | Priya | Testing specialist — test speed, reliability |
| 4 | James | API design purist — types, exports, contracts |
| 5 | Sam | DX advocate — tooling, friction reduction |
| 6 | Lena | Performance engineer — build/bundle optimization |
| 7 | Raj | Security-minded — shift-left, automated scanning |
| 8 | Elena | Monorepo architect — workspace topology, incremental builds |
| 9 | Alex | Junior dev — papercuts, onboarding, documentation |
| 10 | Derek | Startup CTO — shipping speed, cut complexity |

## Condorcet Pairwise Results

Each cell shows how many of 10 voters prefer the row candidate over the column
candidate. **Bold** = winner of that matchup.

|   | A | B | C | D | E | F | G | H | I | J | K | L | M | N | O |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **A** | — | **6** | **9** | **6** | **6** | **9** | **9** | **8** | **10** | **10** | **9** | **10** | **9** | **10** | **10** |
| **B** | 4 | — | **9** | 3 | 4 | **9** | **9** | **8** | **8** | **9** | **9** | **9** | **9** | **9** | **9** |
| **C** | 1 | 1 | — | 2 | 2 | **6** | **9** | **7** | **7** | **9** | **9** | **7** | **8** | **7** | **8** |
| **D** | 4 | **7** | **8** | — | 4 | **9** | **9** | **8** | **10** | **9** | **9** | **10** | **9** | **9** | **9** |
| **E** | 4 | **6** | **8** | **6** | — | **9** | **9** | **8** | **9** | **9** | **9** | **9** | **9** | **9** | **9** |
| **F** | 1 | 1 | 4 | 1 | 1 | — | **9** | **7** | **8** | **8** | **9** | **9** | **8** | **7** | **8** |
| **G** | 1 | 1 | 1 | 1 | 1 | 1 | — | **7** | **6** | **6** | **7** | 3 | 1 | 4 | 5 |
| **H** | 2 | 2 | 3 | 2 | 2 | 3 | 3 | — | 4 | 4 | **6** | 1 | 1 | 3 | 3 |
| **I** | 0 | 2 | 3 | 0 | 1 | 2 | 4 | **6** | — | **6** | **7** | 4 | 2 | 4 | 4 |
| **J** | 0 | 1 | 1 | 1 | 1 | 2 | 4 | **6** | 4 | — | **7** | 3 | 2 | 3 | 4 |
| **K** | 1 | 1 | 1 | 1 | 1 | 1 | 3 | 4 | 3 | 3 | — | 2 | 1 | 2 | 2 |
| **L** | 0 | 1 | 3 | 0 | 1 | 1 | **7** | **9** | **6** | **7** | **8** | — | 4 | **6** | **8** |
| **M** | 1 | 1 | 2 | 1 | 1 | 2 | **9** | **9** | **8** | **8** | **9** | **6** | — | **7** | **9** |
| **N** | 0 | 1 | 3 | 1 | 1 | 3 | **6** | **7** | **6** | **7** | **8** | 4 | 3 | — | **7** |
| **O** | 0 | 1 | 2 | 1 | 1 | 2 | 5 | **7** | **6** | **6** | **8** | 2 | 1 | 3 | — |

## Final Consensus Ranking: Top 10

### 1. Consolidate CI Jobs & Eliminate Redundant Installs/Builds
**Condorcet wins: 14/14 (Condorcet winner)**

The CI pipeline has 8+ separate jobs, each independently running `pnpm install
--frozen-lockfile` and often `pnpm -r run build`. Consolidate into a shared
setup job with artifact passing. Expected to save 40-60% of total CI time.

### 2. Make Pre-Push/Pre-Commit Hooks Faster
**Condorcet wins: 13/14**

The pre-push hook runs the full `pnpm check` suite (build + all checks + tests),
blocking pushes for 2+ minutes. Pre-commit runs api-extractor which triggers a
full workspace rebuild. Introduce a lightweight `check:local` mode for hooks that
skips slow tests, integration tests, and non-critical checks.

### 3. Gate E2E/Slow Tests Behind Filters or Separate Workflow
**Condorcet wins: 12/14**

E2E tests (300s timeout, Playwright install) and integration tests run on every
PR regardless of what changed. Move them to a separate, asynchronous CI workflow
triggered by labels or path filters. Fast unit tests remain in the critical path.

### 4. Build/Test Only Changed Packages Using pnpm Filters
**Condorcet wins: 11/14**

CI runs `pnpm -r` (recursive across all 4 packages) even when only one package
changed. Use `pnpm --filter` with git diff detection to build/test only affected
packages and their dependents. Expected 40-75% reduction in per-PR CI time.

### 5. Enable and Cache TypeScript Incremental Compilation
**Condorcet wins: 10/14**

TypeScript incremental builds are configured (`incremental: true`) but
`.tsbuildinfo` files are not cached in CI. Persisting and restoring these
artifacts between runs could save 30-50% on typecheck duration.

### 6. Parallelize Test Execution / Test Sharding
**Condorcet wins: 9/14**

106+ test files across 4 packages run in a single CI job. Shard tests by
package or use Vitest's built-in sharding to distribute across parallel workers
or CI agents.

### 7. Add Single-Package Dev Mode and Filter Shortcuts
**Condorcet wins: 8/14**

Developers working on one package (e.g., `aai-cli`) must know pnpm filter
syntax or rebuild the entire workspace. Add convenience scripts like
`pnpm dev:aai-cli` and document single-package workflows in CLAUDE.md.

### 8. Merge Multiple Vitest Config Files Into One
**Condorcet wins: 7/14**

Multiple vitest configs exist (root, slow, integration) with duplicated
settings. Consolidate into a single config with project presets to reduce
cognitive overhead and configuration drift.

### 9. Replace setTimeout Patterns With Deterministic Test Helpers
**Condorcet wins: 6/14**

1400+ `setTimeout`/delay patterns exist in tests. Systematically replace with
`vi.advanceTimersByTime()` or `vi.waitFor()` to eliminate flakiness from timing
assumptions and speed up test execution.

### 10. Enforce Public/Internal API Boundaries & Automated Break Detection
**Condorcet wins: 5/14 (tiebreaker: margin of victory)**

The main package exports 18+ entry points with a mix of public and internal
exports. API-extractor covers only 2 packages. Add automated breaking change
detection by comparing `.api.md` baselines and enforce import boundaries to
prevent consumers from depending on internal modules.

---

## Individual Engineer Ballots

| Rank | Maya | Carlos | Priya | James | Sam | Lena | Raj | Elena | Alex | Derek |
|------|------|--------|-------|-------|-----|------|-----|-------|------|-------|
| 1 | A | A | F | G | A | B | K | B | M | A |
| 2 | D | B | A | E | E | C | E | A | E | D |
| 3 | E | C | D | D | D | D | D | E | D | I |
| 4 | C | E | B | A | H | E | B | D | B | E |
| 5 | B | D | L | B | I | A | A | C | A | L |
| 6 | F | F | N | F | B | F | F | N | F | B |
| 7 | M | M | E | C | C | N | C | F | L | C |
| 8 | L | L | M | M | F | L | M | M | I | J |
| 9 | J | J | C | I | M | O | O | O | C | M |
| 10 | G | G | O | L | G | M | N | G | H | O |
| 11 | H | N | G | O | N | I | L | I | N | F |
| 12 | N | O | I | N | J | G | G | L | G | N |
| 13 | O | H | H | J | L | J | H | H | O | H |
| 14 | I | I | J | H | O | H | J | K | K | G |
| 15 | K | K | K | K | K | K | I | J | J | K |

## Candidates Not in Top 10

| Rank | Candidate | Why it didn't make the cut |
|------|-----------|---------------------------|
| 11 | **N** - Replace setTimeout patterns | Strong testing benefit but niche concern |
| 12 | **O** - Consolidate test utilities | Maintenance hygiene, not velocity-critical |
| 13 | **I** - Reduce template count | Championed by Derek/Sam but not broadly prioritized |
| 14 | **G** - API boundary enforcement | Only James ranked it #1; most saw it as long-term |
| 15 | **H** - Better CLI error messages | DX improvement, not build/test velocity |
