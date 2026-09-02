/**
 * The line-scanning rules `guard-invariants.mjs` enforces, as data.
 *
 * A side-effect-free module set, for two reasons:
 *
 *   1. **The gate's spec can import the real values.** An earlier draft had
 *      `packages/aai-templates/guard-invariants-gate.test.ts` regex-scrape
 *      `re: "..."` out of the script's source, which is fragile in the exact
 *      way that matters here — a rule whose shape drifted would silently stop
 *      being parsed, so the suite proving no rule is dead would itself go
 *      blind. It cannot import the gate instead, because importing that module
 *      runs the scan and calls `process.exit`.
 *   2. **The patterns can be COMPOSED.** Spelled out end to end, several of
 *      these regexes are long enough that biome's `noSecrets` entropy heuristic
 *      scores them as credentials. `guard-invariants-ere.mjs` holds the named
 *      fragments they are built from.
 *
 * ## This file is a BARREL, and what the split is by
 *
 * It reached 649 lines against a 500-line source cap. The five modules under it
 * are cut by SUBJECT rather than by size:
 *
 * | module | holds |
 * | --- | --- |
 * | `guard-invariants-ere.mjs`          | the regex vocabulary |
 * | `guard-invariants-scopes.mjs`       | the eight corpora, and `SCAN_CORPORA`, the floor under each |
 * | `guard-invariants-rules-timing.mjs` | rules 3, 4, 19, 21, 23, 31 — how code waits |
 * | `guard-invariants-rules-workflow.mjs` | rules 26 and 30, the two over a shipped `workflows/` body |
 * | `guard-invariants-rules-shape.mjs`  | rules 2, 17, 18, 22, 28 — a value's shape, re-derived |
 * | `guard-invariants-rules-state.mjs`  | rules 5, 8, 9, 11, 16, 24, 25, 27, 29 — state someone else owns |
 *
 * Everything downstream imports from HERE and nothing changed for it:
 * `LINE_RULES` and the scope constants are re-exported.
 *
 * Two properties survive the split, both already paid for in this repo:
 *
 *   - **Rule IDs are STABLE and the retired ones stay retired.** 6 is retired
 *     and 15 reserved; the numbers appear in commit messages and in the
 *     baseline's history, so nothing was renumbered.
 *   - **Every module here matches most of its own rules**, because each
 *     `label` and `re` is a description of the thing it bans. All six are in
 *     `guard-invariants.mjs`'s `SELF_REFERENTIAL` set alongside the gate, the
 *     baseline and the gate's spec. AGENTS.md records this trap being paid for
 *     four times; a split that forgot one file would be the fifth.
 *
 * Every pattern is handed to `git grep -E`, so it must be POSIX ERE. In
 * particular `\b` is a GNU extension that git's own matcher does not implement:
 * a pattern using one matches NOTHING and the rule reports success forever.
 */

import { SHAPE_RULES } from "./guard-invariants-rules-shape.mjs";
import { STATE_RULES } from "./guard-invariants-rules-state.mjs";
import { TIMING_RULES } from "./guard-invariants-rules-timing.mjs";
import { WORKFLOW_BODY_RULES } from "./guard-invariants-rules-workflow.mjs";

export {
  GUEST_SURFACE_PATHSPECS,
  RUNTIME_EGRESS_PATHSPECS,
  SCAN_CORPORA,
  SCRIPT_PATHSPECS,
  SESSION_SURFACE_PATHS,
  SHIPPED_SOURCE_PATHSPECS,
  SOURCE_PATHSPECS,
  TEMPLATE_PATHSPECS,
  WORKFLOW_BODY_PATHSPECS,
} from "./guard-invariants-scopes.mjs";

/**
 * @typedef {object} LineRule
 * @property {number} id      Stable rule number, quoted in the baseline and in commits.
 * @property {string} key     Baseline key.
 * @property {string} label   Short name for the summary line.
 * @property {string} re      POSIX ERE handed to `git grep -E`.
 * @property {string[]} paths Pathspecs to scan.
 * @property {boolean} skipComments Drop matches on comment-only lines.
 * @property {string} remedy  What to do instead — printed on failure.
 * @property {{ matches: string[], ignores: string[] }} [samples]
 *   A positive and a negative sample, carried BY THE RULE.
 *
 *   `packages/aai-templates/guard-invariants-gate.test.ts` holds a `SAMPLES`
 *   table keyed by rule, which is the right discipline in the wrong file: a
 *   widened pattern and the sample proving it widened land in two packages, and
 *   rule 3 shipped for months with a SINGLE-LINE positive sample while the rule
 *   was blind to the multi-line form the code is actually written in — the
 *   guard-under-the-guard passing over the exact gap it exists to find. A rule
 *   that carries its own samples cannot drift from them. The spec should prefer
 *   these where present.
 */

/**
 * Every line rule, SORTED BY ID.
 *
 * Sorted rather than concatenated in module order, so the gate's summary reads
 * in rule-number order and the generated baseline's key order is a function of
 * the rule set rather than of which file a rule happens to live in — otherwise
 * moving a rule between the four rule modules would rewrite the baseline —
 * which is exactly what the 26/30 move would otherwise have done.
 *
 * @type {LineRule[]}
 */
export const LINE_RULES = [
  ...SHAPE_RULES,
  ...TIMING_RULES,
  ...STATE_RULES,
  ...WORKFLOW_BODY_RULES,
].sort((a, b) => a.id - b.id);
