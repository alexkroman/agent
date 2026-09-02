// Copyright 2026 the AAI authors. MIT license.
/**
 * The `no-check` half of `check-doc-examples.mjs`, against a COMMITTED PER-FILE
 * BASELINE.
 *
 * That gate does two jobs. One extracts every ```ts fence in the published
 * packages' doc comments, the user-facing markdown and the studio prompts and
 * COMPILES them; the other counts the fences marked `no-check`, which the first
 * job walks straight past, and holds each file to a budget. They share a parse
 * and nothing else — same seam `_ratchet.mjs` already sits on — so the second
 * lives here and the entry point stays where `package.json` and the `GATES`
 * table name it.
 *
 * ## Why `no-check` is counted at all
 *
 * A skipped fence is a shipped example nothing compiles — the state that gate
 * exists to end — and it was uncounted, so nothing stopped the number growing.
 * Not theoretical: `packages/aai/README.md`'s "Testing an agent" example
 * imported `withDiscoveredTools` from `@alexkroman1/aai/testing`, a name that
 * subpath does not export, so a reader who copied it got an unresolved-export
 * build error. The fence said `no-check`, so the gate walked past it.
 *
 * `check-escape-hatches.mjs`'s argument applies verbatim ("uncounted patterns
 * grow"), so this runs on the SAME machinery — `_ratchet.mjs`, with
 * `no-check-baseline.json` as the per-file budget. A file may hold fewer; a file
 * may never hold more; a file absent from the baseline may hold none. `--update`
 * lowers an entry and refuses to raise one, so recording a removal is one
 * command and blessing an addition is a hand edit a reviewer sees. It is a DEBT
 * ratchet whose goal is zero: retire an entry by making the example
 * SELF-CONTAINED, never by deleting the fence.
 *
 * The caller runs this FIRST, before the scratch tree and the compiler, so a
 * debt regression fails in a fraction of a second even though the gate itself is
 * scheduled after the build (examples resolve the PUBLISHED types).
 */

import { readFileSync } from "node:fs";

import {
  assertNotUniversallyEmpty,
  compareToBaseline,
  totalOf,
  updateBaseline,
  warnStale,
} from "./_ratchet.mjs";

const BASELINE_PATH = new URL("no-check-baseline.json", import.meta.url);
const GATE = "check-doc-examples";
/** What every `_ratchet.mjs` call needs: who is reporting, and how to record. */
const RATCHET = { gate: GATE, updateCommand: `node scripts/${GATE}.mjs --update` };

/**
 * The one group. `_ratchet.mjs` serves gates with several patterns; this one has
 * a single hatch, so the baseline is one key deep — same shape as
 * `escape-hatch-baseline.json`, on the same refuse-to-raise contract.
 */
const GROUPS = [{ key: "no-check", label: "no-check" }];

/**
 * TWO floors, because this gate's corpus is a PARSE and not a `git grep`.
 *
 * `_ratchet.mjs`'s `assertScanCorpus` floors the file set a pathspec resolves
 * to, which is right for the two grep-based ratchets and wrong here: the gate's
 * files come from `SOURCE_GLOBS` / `MARKDOWN_FILES` / `PROMPT_SOURCES` filtered
 * in JS, and what can go blind is either the file list or the FENCE MATCHER. So
 * both are floored, for the reason that file spells out — a scan that stops
 * matching prints the same checkmark as a clean tree, and here it would also
 * report a debt of zero. `MIN_EXAMPLES` there covers neither: it counts only the
 * CHECKED fences, so a matcher that quietly stopped finding either kind in some
 * documents shrinks both counts with nothing saying so.
 *
 * **MEASURED 2026-09-01: 618 documents, 307 ts/tsx fences** (178 compile, 129
 * are `no-check`). Deterministic on a given tree, so the margin is only for
 * documents and fences legitimately removed — every way this scan goes blind
 * takes one of them down by far more.
 */
const MIN_DOCUMENTS = 580;
const MIN_FENCES = 285;

const ADVICE = `Make the example self-contained instead — declare the types it
references, import what it uses. If a fence genuinely cannot compile (a
type-shape listing, a fragment of a file the reader owns), raise its number in
scripts/no-check-baseline.json BY HAND, so the increase is in the diff.`;

/**
 * Hold every document to its `no-check` budget, or exit.
 *
 * @param {object} scan
 * @param {{ origin: string, line: number, lang: string, checked: boolean }[]} scan.fences
 *   Every ts/tsx fence found, checked and skipped alike.
 * @param {number} scan.documentsScanned How many documents were read.
 * @param {boolean} scan.update `--update`: lower the baseline and exit.
 */
export function enforceNoCheckBudget({ fences, documentsScanned, update }) {
  if (documentsScanned < MIN_DOCUMENTS || fences.length < MIN_FENCES) {
    console.error(`
${GATE}: read ${documentsScanned} document(s) holding ${fences.length} ts/tsx fence(s), below
the floor of ${MIN_DOCUMENTS} / ${MIN_FENCES}. The extractor is walking less of the tree than it is
supposed to, and a ratchet over an empty corpus reports a debt of 0 and prints a
checkmark. Check SOURCE_GLOBS for a renamed package, MARKDOWN_FILES and
PROMPT_SOURCES for a moved file, and the fence regex in extractFences. If they
were genuinely removed, lower the floor deliberately, in the same commit.
`);
    process.exit(1);
  }

  const skipped = fences.filter((fence) => !fence.checked);
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

  /** `{ "no-check": Map<file, count> }`, the shape the shared engine reads. */
  const byFile = new Map();
  for (const fence of skipped) byFile.set(fence.origin, (byFile.get(fence.origin) ?? 0) + 1);
  const counts = new Map([["no-check", byFile]]);

  if (update) {
    updateBaseline({
      ...RATCHET,
      baselinePath: BASELINE_PATH,
      baseline,
      groups: GROUPS,
      counts,
      advice: `The baseline only ratchets down. ${ADVICE}`,
      describe: () =>
        "Per-file budget of `no-check` doc fences — examples this repo SHIPS and " +
        "compiles nowhere. See scripts/check-doc-examples.mjs. Goal is zero; " +
        "`--update` lowers an entry and refuses to raise one.",
    });
  }

  const { violations, stale, allowedTotal, currentTotal } = compareToBaseline(
    GROUPS,
    baseline,
    counts,
  );

  if (violations.length > 0) {
    console.error(`\n${GATE}: ${violations.length} file(s) over their no-check baseline:\n`);
    for (const { file, budget, count } of violations) {
      console.error(`  ${file}  allowed ${budget}, found ${count}`);
      for (const fence of skipped.filter((f) => f.origin === file)) {
        console.error(`      ${file}:${fence.line}  \`\`\`${fence.lang} no-check`);
      }
    }
    console.error(`
A \`no-check\` fence is a shipped example nothing compiles — which is how
packages/aai/README.md came to import a name its own subpath does not export.
${ADVICE}
\`--update\` will not do it for you.
`);
    process.exit(1);
  }

  // Every no-check fence gone at once is a blind matcher until proven otherwise.
  assertNotUniversallyEmpty({ ...RATCHET, allowedTotal, currentTotal });

  // Not a failure: the author who made an example compile should not be blocked
  // for not having also run --update. But unclaimed headroom is a hatch the NEXT
  // branch gets for free, which is the leak that makes a ratchet stop ratcheting.
  warnStale({ ...RATCHET, stale });

  console.log(
    `${GATE}: ${currentTotal} no-check fence(s) against a budget of ` +
      `${totalOf(baseline["no-check"])} — ${fences.length} fence(s), ${documentsScanned} docs. ✓`,
  );
}
