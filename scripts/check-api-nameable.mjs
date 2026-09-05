#!/usr/bin/env node

/**
 * Every type on a published surface must be NAMEABLE, against a committed
 * per-file baseline.
 *
 * A published signature may reference a type its package exports from no
 * subpath at all. The value still passes — structural typing does not care —
 * but a consumer cannot write the type down: no `import type` names it, so a
 * shared fixture, a helper that builds options up, or a variable holding one
 * field has to be inferred at every use or cast. Changing such a type is also
 * invisible in review in the one place review looks, since nothing lists it as
 * part of the surface.
 *
 * ## What let this through, and why a new gate rather than an existing one
 *
 * Three things already touch this and none of them fails:
 *
 *   - `api-report.mjs` sets `includeForgottenExports: true`, which RECORDS such
 *     a type in `etc/*.api.md` as a bare `declare` with no `export` keyword —
 *     deliberately, and its comment says why: left out, "changing one is
 *     invisible in review even though it can break a build". Recording is not
 *     refusing, and the report is the same either way.
 *   - TypeDoc's `treatWarningsAsErrors` fails on one — but only inside the
 *     packages `docs/typedoc.json` renders, which is two of the four published
 *     ones, and only for a type the render can actually reach.
 *   - `check:api-contracts` hashes the report, so it sees the DECLARATION move.
 *     It has no opinion about whether the name is importable.
 *
 * So the surface a consumer must satisfy and the surface a consumer can NAME
 * had drifted apart with nothing measuring the gap. It was found the expensive
 * way: `@alexkroman1/aai-runtime/eval` and `/testing` — the eval and workflow
 * test surface the `aai` README teaches — could not be rendered at all, because
 * `EvalSessionOptions.generate`, `EvalWorkflowsOptions.speech`,
 * `RunWorkflowOptions.journal` and `WorkflowTestRead.kind` each named a type
 * published by nothing.
 *
 * ## Nameable from the PACKAGE, not from the subpath
 *
 * A name exported by any subpath of the same package counts. `WorkflowSummary`
 * is referenced by `@alexkroman1/aai/manifest` and exported by
 * `@alexkroman1/aai/workflow-api`, and a consumer imports it from there —
 * inconvenient at worst, never impossible. Scoring per subpath would report 419
 * findings, almost all of that shape, and a gate whose first run is mostly
 * noise is a gate that gets an allowlist and then gets ignored. Per package it
 * is 83, and every one is a name a consumer genuinely cannot write.
 *
 * ## Why a baseline rather than zero
 *
 * Some of the 83 must STAY unnameable, and they are the reason this is a
 * ratchet rather than an absolute. `packages/aai/typedoc.json`'s
 * `intentionallyNotExported` argues each: `Literal`, `RejectThenable`, and the
 * twenty-odd `*Misuse` / `*Field` types are the IMPLEMENTATION of a compile
 * error — an author meets one as the message tsc prints, never by name — and
 * exporting them to satisfy a gate would put pure type-level machinery on the
 * published surface, which is the opposite of the fix. The rest (the workflow
 * journal record shapes on `aai-runtime`'s embedder surface, chiefly) are real
 * and are what the ratchet is pointed at.
 *
 * So: a report may hold fewer than its baseline, never more, and one absent
 * from the baseline may hold none. `--update` lowers and REFUSES to raise, so
 * recording a removal is one command and blessing an addition needs a hand edit
 * in a reviewable diff. Same contract as `check:hatches` and
 * `check:invariants`, same engine.
 *
 * ## Usage
 *
 *   node scripts/check-api-nameable.mjs            # check
 *   node scripts/check-api-nameable.mjs --update   # lower the baseline to the tree
 *
 * It reads the COMMITTED reports under `packages/*\/etc/`, not a build, so it
 * needs no `dist/`. `check:api-report` is what keeps those current; this gate
 * and that one are the two halves of "the report is right" and "the report
 * describes something importable".
 */

import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { reportSource } from "./_api-surface.mjs";
import { parseScriptArgs } from "./_args.mjs";
import { compareNames, repoRoot } from "./_fs.mjs";
import {
  assertNotUniversallyEmpty,
  compareToBaseline,
  totalOf,
  updateBaseline,
  warnStale,
} from "./_ratchet.mjs";

const require = createRequire(import.meta.url);
// api-extractor bundles a TypeScript compatible with its own output, for the
// reason `_api-surface.mjs` gives: this repo is on `typescript@7`, whose native
// compiler exposes no JS API.
const extractorRequire = createRequire(require.resolve("@microsoft/api-extractor/package.json"));
const ts = extractorRequire("typescript");

const ROOT = repoRoot(import.meta.url).replace(/\/$/, "");
const GATE = "check-api-nameable";
const UPDATE_COMMAND = "node scripts/check-api-nameable.mjs --update";
const BASELINE_PATH = join(ROOT, "scripts/api-nameable-baseline.json");
const EXPORTS_PATH = join(ROOT, "API-EXPORTS.json");
const REPORT_GLOB = "packages/*/etc/*.api.md";

/**
 * Minimum reports the scan must find.
 *
 * Its whole success output is a count, so a glob that stopped matching would
 * print "every published type is nameable ✓" over nothing — the failure shape
 * this repo has paid for repeatedly. Measured actual: 36.
 */
const MIN_REPORTS = 30;

/**
 * Minimum published subpaths `API-EXPORTS.json` must describe.
 *
 * The same floor one input over. An empty or renamed export map would make
 * EVERY name unnameable rather than none, so this one fails loud instead of
 * quiet — but it is still a read that can silently return nothing.
 */
const MIN_SPECS = 25;

/** One group: the ratchet engine is built for several, this gate has one. */
const GROUPS = [{ key: "unnameable", label: "unnameable" }];

/** `@alexkroman1/aai-ui/internal` -> `aai-ui`. A bare name maps to itself. */
function packageOf(spec) {
  const bare = spec.startsWith("@alexkroman1/") ? spec.slice("@alexkroman1/".length) : spec;
  return bare.split("/")[0];
}

/** Every name any subpath of a package exports, keyed by package directory name. */
function nameablePerPackage() {
  const specs = JSON.parse(readFileSync(EXPORTS_PATH, "utf8"));
  const entries = Object.entries(specs);
  if (entries.length < MIN_SPECS) {
    console.error(
      `\n${GATE}: API-EXPORTS.json describes only ${entries.length} subpath(s), under the ` +
        `floor of ${MIN_SPECS}.\n\nThat read has gone blind — with an empty map every name ` +
        "scores as unnameable, so this\nfails rather than reporting a tree-wide regression " +
        "that is not real. Run `pnpm api-report`.\n",
    );
    process.exit(1);
  }
  /** @type {Map<string, Set<string>>} */
  const byPackage = new Map();
  for (const [spec, names] of entries) {
    const pkg = packageOf(spec);
    let set = byPackage.get(pkg);
    if (!set) {
      set = new Set();
      byPackage.set(pkg, set);
    }
    for (const name of names) set.add(name);
  }
  return byPackage;
}

/**
 * The names one report DECLARES without exporting.
 *
 * A real parse rather than a scan for `declare `, for the reason
 * `_api-surface.mjs` gives about the other direction: a forgotten type sits at
 * the same indentation as an exported one and differs only by a modifier. An
 * `export { X }` re-export declaration is skipped — it names something
 * importable by construction.
 */
function forgottenNames(report, label) {
  const source = reportSource(report, label);
  const file = ts.createSourceFile(
    "api-report.d.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  /** @type {string[]} */
  const names = [];
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) continue;
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const name = statement.name?.text;
    if (name) names.push(name);
  }
  return names;
}

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { update: { type: "boolean" } },
});

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const nameable = nameablePerPackage();

const reports = globSync(REPORT_GLOB, { cwd: ROOT }).sort(compareNames);
if (reports.length < MIN_REPORTS) {
  console.error(
    `\n${GATE}: found only ${reports.length} report(s) under ${REPORT_GLOB}, under the floor ` +
      `of ${MIN_REPORTS}.\n\nThe glob has stopped matching, or the reports were not generated. ` +
      "Either way this\ngate would otherwise print a checkmark over nothing.\n",
  );
  process.exit(1);
}

/** file -> the unnameable names it declares, in report order. */
const occurrences = new Map();
/** file -> count, for the one group. */
const unnameable = new Map();
/** The shape `_ratchet.mjs` compares: group key -> file -> count. */
const counts = new Map([["unnameable", unnameable]]);

for (const file of reports) {
  const pkg = file.split("/")[1];
  const found = forgottenNames(readFileSync(join(ROOT, file), "utf8"), file).filter(
    (name) => !nameable.get(pkg)?.has(name),
  );
  if (found.length === 0) continue;
  occurrences.set(file, found);
  unnameable.set(file, found.length);
}

if (FLAGS.update === true) {
  updateBaseline({
    gate: GATE,
    baselinePath: BASELINE_PATH,
    baseline,
    groups: GROUPS,
    counts,
    advice:
      "The baseline only ratchets down. Export the type from the barrel that already\n" +
      "publishes the field referencing it. If it must stay unnameable — the way the\n" +
      "`*Misuse` compile-error types must — raise the number by hand so the increase\n" +
      "shows up in the diff, and say why in `intentionallyNotExported` beside it.",
    describe: () =>
      "Per-report budget of types referenced by a published surface but exported " +
      "by no subpath of their own package. Only ever lowered — see " +
      "scripts/check-api-nameable.mjs.",
  });
}

const MAX_SHOWN = 20;
const { violations, stale, allowedTotal, currentTotal } = compareToBaseline(
  GROUPS,
  baseline,
  counts,
);

console.log(`${GATE}: unnameable published types vs api-nameable-baseline.json\n`);
console.log(
  `  reports=${reports.length}  allowed=${totalOf(baseline.unnameable)}  now=${currentTotal}`,
);

if (violations.length > 0) {
  console.error(`\n${GATE}: ${violations.length} report(s) over their baseline:\n`);
  for (const { file, budget, count } of violations) {
    console.error(`  ${file}  allowed ${budget}, found ${count}`);
    const names = occurrences.get(file) ?? [];
    for (const name of names.slice(0, MAX_SHOWN)) console.error(`      ${name}`);
    if (names.length > MAX_SHOWN) console.error(`      … and ${names.length - MAX_SHOWN} more`);
  }
  console.error(
    "\nEach name above is referenced by a published signature and exported by no\n" +
      "subpath of its package, so a consumer can pass the value and cannot write the\n" +
      "type. Export it from the barrel that already publishes the field referencing\n" +
      "it. If it must stay unnameable — a compile-error type an author only ever\n" +
      "READS in a tsc message — raise the number in\n" +
      "scripts/api-nameable-baseline.json by hand and say why. `--update` will not\n" +
      "do it for you.\n",
  );
  process.exit(1);
}

assertNotUniversallyEmpty({
  gate: GATE,
  allowedTotal,
  currentTotal,
  updateCommand: UPDATE_COMMAND,
});
warnStale({ gate: GATE, stale, updateCommand: UPDATE_COMMAND, maxShown: MAX_SHOWN });

console.log(`\n${GATE}: every report within its baseline. ✓`);
