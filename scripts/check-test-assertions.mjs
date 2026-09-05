#!/usr/bin/env node

/**
 * Assertion gate: every `test()` / `it()` body must assert something.
 *
 * A test with no assertion still runs the code, still counts in the green
 * "442 passed", and still shows up in coverage — while checking nothing but
 * "did not throw synchronously". That is the worst failure mode a suite has,
 * because it is indistinguishable from real coverage at every level a human
 * or a CI dashboard looks at.
 *
 * The ones this gate was written against were not hypothetical:
 *
 * - `"/health returns ok JSON"` created a server, never sent a request, and
 *   asserted nothing. It passed whatever `/health` returned — a real version
 *   of the same test lived 30 lines below it.
 * - `"onHistory appends and onUserTranscript pushes user messages"` called
 *   three methods and checked none of the three claims in its own name.
 * - `"does not block different keys on each other"` encoded its invariant as
 *   a bare `await`: a regression made it HANG to the suite timeout rather
 *   than fail.
 *
 * The third of those is the one the gate itself was blind to for a while.
 * Eleven `test.concurrent(…)` bodies in `packages/aai-cli/src/e2e.test.ts` stated
 * their claims as bare `await locator.waitFor()` — a Playwright regression
 * would have hung them to the tier's 300s timeout — and the old opener regex
 * could not see a `test.concurrent` at all. The parser this gate runs on now
 * walks the call chain instead of enumerating its shapes; see
 * `_test-assertions-parse.mjs`.
 *
 * "Does not throw" is a legitimate thing to test — it just has to be said:
 * `expect(fn).not.toThrow()`, `await expect(p).resolves.toBeUndefined()`.
 * Writing it down is what makes it survive a refactor and what tells the next
 * reader the empty body was deliberate.
 *
 * There is deliberately NO allowlist. The baseline is zero, like
 * `file-length-allowlist.json`'s empty state — an escape hatch here would be
 * indistinguishable from the bug.
 *
 * Wired up as `pnpm check:test-assertions`, in `scripts/check.mjs` and the CI
 * check job (both — see the root CLAUDE.md on ratchets that lived in only one).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./_fs.mjs";
import { findTests } from "./_test-assertions-parse.mjs";

const ROOT = repoRoot(import.meta.url);

/**
 * Floors, because this gate's entire success output is a COUNT.
 *
 * "all 0 test(s) across 0 file(s) assert something ✓" is the exact shape of a
 * healthy run, so a glob that stopped matching or a parser that stopped
 * recognising `test(` would print a checkmark over nothing — which is the
 * failure this gate exists to catch, arriving in the gate itself. ~635 files and
 * ~8,000 tests today; the floors sit well under both so ordinary churn never
 * trips them, and any plausible breakage lands at zero.
 */
const MIN_TEST_FILES = 200;
const MIN_TESTS_SCANNED = 2000;

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "*.test.ts", "*.test.tsx"],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
)
  .split("\n")
  .filter(Boolean)
  // Built copies of the template tests ship in the CLI's dist; the sources
  // they came from are already in the list.
  .filter((f) => !(f.includes("/dist/") || f.includes("node_modules/")));

if (files.length < MIN_TEST_FILES) {
  console.error(
    `check-test-assertions: found ${files.length} test file(s), below the floor of ` +
      `${MIN_TEST_FILES} — is the glob still right?`,
  );
  process.exit(1);
}

const offenders = [];
const unparsable = [];
let scanned = 0;

for (const file of files) {
  const { tests, errors } = findTests(file, readFileSync(join(ROOT, file), "utf8"));
  if (errors.length > 0) {
    unparsable.push({ file, why: errors[0] });
    continue;
  }
  for (const { line, title, asserts } of tests) {
    scanned++;
    if (!asserts) offenders.push({ file, line, title });
  }
}

// A file the parser choked on is reported before anything else: it contributed
// zero tests, so letting it through would understate every count below it.
if (unparsable.length > 0) {
  console.error(`check-test-assertions: ${unparsable.length} test file(s) failed to parse.\n`);
  for (const { file, why } of unparsable) console.error(`  ${file}  ${why}`);
  console.error(
    "\nThe gate cannot vouch for a file it could not read. Fix the syntax, or —\n" +
      "if the file is valid and oxc-parser disagrees — say so in\n" +
      "packages/aai-gates/src/test-assertion-gate.test.ts before working around it.",
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(
    `check-test-assertions: ${offenders.length} of ${scanned} test(s) assert nothing — they pass no matter what the code does.\n`,
  );
  for (const { file, line, title } of offenders) {
    console.error(`  ${file}:${line}  ${title}`);
  }
  console.error(
    '\nAssert the claim in the test\'s name. If the claim really is "does not throw",\n' +
      "say so: expect(fn).not.toThrow() / await expect(p).resolves.toBeUndefined().",
  );
  process.exit(1);
}

if (scanned < MIN_TESTS_SCANNED) {
  console.error(
    `check-test-assertions: parsed ${scanned} test(s) out of ${files.length} file(s), below the ` +
      `floor of ${MIN_TESTS_SCANNED}.\n\n` +
      "The files were found, so this is the parser: it has stopped recognising\n" +
      "the shape a test is written in, and a gate whose success output is a\n" +
      "count reports that as a clean run. Its spec is\n" +
      "packages/aai-gates/src/test-assertion-gate.test.ts.",
  );
  process.exit(1);
}

console.log(
  `check-test-assertions: all ${scanned} test(s) across ${files.length} file(s) assert something. ✓`,
);
