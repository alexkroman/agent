/**
 * The rules `guard-invariants.mjs` enforces, as data.
 *
 * TWO KINDS now, and the difference is the ENGINE rather than the subject. A
 * {@link LineRule} carries a POSIX ERE handed to `git grep -E`; a
 * {@link NodeRule} carries a `match(node)` over a parsed AST
 * (`scripts/_ast-scan.mjs`). Both produce the same `{ file, line, text }`
 * occurrences and share one baseline file, so a rule keeps its id, its key and
 * its recorded budgets across a migration between them. Which kind a rule
 * should be is decided by what it is ASKING: a rule about a name or a string is
 * a substring question and grep answers it in milliseconds, where a rule about
 * SYNTAX — which argument a value sits in, whether a callback is `async`,
 * whether a delay is zero — is not, and every gap this gate has ever had was
 * one of the second kind written as the first. `guard-invariants-nodes.mjs`
 * carries the node vocabulary, beside the ERE one.
 *
 * A side-effect-free module set, for two reasons:
 *
 *   1. **The gate's spec can import the real values.** An earlier draft had
 *      `packages/aai-templates/src/guard-invariants-gate.test.ts` regex-scrape
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
 * It reached 649 lines against a 500-line source cap. The seven modules under
 * it are cut by SUBJECT rather than by size — count the table, which has grown
 * twice since this line first said "five":
 *
 * | module | holds |
 * | --- | --- |
 * | `guard-invariants-ere.mjs`          | the regex vocabulary (line rules) |
 * | `guard-invariants-nodes.mjs`        | the node vocabulary (node rules) |
 * | `guard-invariants-scopes.mjs`       | the eight corpora, and `SCAN_CORPORA`, the floor under each |
 * | `guard-invariants-rules-timing.mjs` | rules 3, 4, 19, 21, 23, 31 — how code waits (NODE rules) |
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
 * A LINE rule's pattern is handed to `git grep -E`, so it must be POSIX ERE. In
 * particular `\b` is a GNU extension that git's own matcher does not implement:
 * a pattern using one matches NOTHING and the rule reports success forever. A
 * NODE rule has no such trap — an `Identifier` has a `name` and comparing it is
 * exact — which is half of why the timing family moved.
 */

import { SHAPE_RULES } from "./guard-invariants-rules-shape.mjs";
import { STATE_RULES } from "./guard-invariants-rules-state.mjs";
import { TESTING_RULES } from "./guard-invariants-rules-testing.mjs";
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
  TEST_FILE_PATHSPECS,
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
 *   `packages/aai-templates/src/guard-invariants-gate.test.ts` holds a `SAMPLES`
 *   table keyed by rule, which is the right discipline in the wrong file: a
 *   widened pattern and the sample proving it widened land in two packages, and
 *   rule 3 shipped for months with a SINGLE-LINE positive sample while the rule
 *   was blind to the multi-line form the code is actually written in — the
 *   guard-under-the-guard passing over the exact gap it exists to find. A rule
 *   that carries its own samples cannot drift from them. The spec should prefer
 *   these where present.
 */

/**
 * @typedef {object} NodeRule
 * @property {number} id      Stable rule number, quoted in the baseline and in commits.
 * @property {string} key     Baseline key — the SAME key a line rule would use, so a
 *   rule migrating between the two engines keeps its recorded budgets.
 * @property {string} label   Short name for the summary line.
 * @property {(node: import("oxc-parser").Node) => boolean} match
 *   Whether this AST node is an occurrence. Called for every node in the corpus.
 *   Typed as oxc's own `Node` union rather than `object`, which has no members
 *   at all — so a rule reading `node.arguments` or `node.callee` could not be
 *   checked, in the engine whose whole advantage over the line rules is that it
 *   sees SHAPE.
 * @property {(node: import("oxc-parser").Node) => import("oxc-parser").Node} [at]
 *   Which node's position to REPORT, when it is not the matched one. Rule 21
 *   matches the whole `expect.poll(...)` call and reports at `.poll`, because
 *   wrapped, that call begins on an `await expect` line naming nothing a reader
 *   can act on.
 * @property {string[]} paths Pathspecs to scan.
 * @property {string} remedy  What to do instead — printed on failure.
 * @property {{ matches: string[], ignores: string[] }} [samples]
 *   Positive and negative samples as SOURCE, parsed by the spec.
 *
 *   The difference from a line rule's samples is the whole argument for this
 *   rule kind. A line sample is a LINE, so the sample proving rule 3 saw the
 *   wrapped `Promise.race([` could not be written in the wrapped form — and
 *   that rule shipped for months with a single-line positive sample while blind
 *   to the shape the code is written in, the guard-under-the-guard passing over
 *   the exact gap it exists to find. These are snippets, written the way the
 *   code is.
 *
 *   No `skipComments` twin, either: a comment is not a node.
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
export const LINE_RULES = [...SHAPE_RULES, ...STATE_RULES, ...WORKFLOW_BODY_RULES].sort(
  (a, b) => a.id - b.id,
);

/**
 * Every node rule, SORTED BY ID — the timing family, and the testing one.
 *
 * Separate from {@link LINE_RULES} because the two are SCANNED differently and
 * by nothing else: they share the baseline file, the per-file budgets, the
 * `--update` contract and the failure report, and `guard-invariants.mjs`
 * interleaves them by id so the summary still reads in rule-number order.
 *
 * Which kind a new rule should be: ask whether the thing being banned is a
 * NAME or a SHAPE. `delete process.env.X` (rule 5) and a `/tmp` literal (rule
 * 11) are names, grep answers them exactly, and a parse would buy nothing.
 * "A callback that is `async`", "a delay that is zero", "a timer among a
 * race's elements" are shapes, and every one of those written as a pattern has
 * cost this repo a silent blind spot.
 *
 * @type {NodeRule[]}
 */
export const NODE_RULES = [...TIMING_RULES, ...TESTING_RULES].sort((a, b) => a.id - b.id);
