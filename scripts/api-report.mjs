#!/usr/bin/env node

/**
 * Committed API reports for the published type surface.
 *
 * ## The gap this closes
 *
 * Three things already guard what gets published, and none of them looks at a
 * type SIGNATURE:
 *
 *   * `sdk/exports.test.ts` pins the runtime export NAMES. It notices a symbol
 *     appearing or disappearing and nothing about its shape.
 *   * `publint` + `attw` check that the `exports` map resolves and that the
 *     types are reachable under each module resolution mode. Both are questions
 *     about packaging, not about API.
 *   * The `.test-d.ts` type tests cover `aai`'s root entry and `aai-ui`'s four
 *     hooks. AGENTS.md's "Known limitations" says so directly: the subpath
 *     exports are not covered.
 *
 * So widening a parameter, making a field optional, adding a union member, or
 * changing a return type on any of the nineteen published entry points is
 * invisible in review. That matters most for the decision it feeds: the
 * changeset bump type. "Is this breaking?" is currently a judgement made from
 * memory, and a `patch` that was really a `major` is only discovered by the
 * consumer whose build breaks.
 *
 * An API report turns it into a diff. `etc/<subpath>.api.md` is the rolled-up
 * public `.d.ts` for one entry point, committed; changing a signature changes
 * the report, and the reviewer sees the before and after side by side.
 *
 * ## …and one combined file, for readers rather than reviewers
 *
 * Twenty files is the right shape for a REVIEW — a signature change lands in
 * the one report that owns it, and the diff is small. It is the wrong shape for
 * an agent trying to answer "what does this SDK expose?", which is twenty reads
 * plus knowing the list to read in the first place, i.e. exactly the hand-kept
 * list this script exists to not have.
 *
 * API Extractor itself cannot produce the combined file: `mainEntryPointFilePath`
 * is a single string, one invocation analyses one entry point, and multi-entry
 * support is a long-standing unimplemented upstream request. What it CAN do is
 * be pointed at a synthetic barrel (`export * as stt from "./dist/…"`), which
 * yields one deduplicated rollup — but only per package, so the repo would still
 * need three, and every symbol loses the `export` keyword to a `declare
 * namespace` block. Measured against that, deduplication buys almost nothing
 * here: 573 top-level declarations across the twenty reports resolve to 539
 * distinct names, so 34 lines — 6% — are the entire saving.
 *
 * So `API.md` is the twenty reports concatenated, each under a heading naming
 * its package and subpath, generated in the same pass that writes them and
 * compared by `--check` the same way. It is DERIVED, so it cannot drift from
 * the reports, and the reports stay the thing a reviewer reads.
 *
 * ## Entry points are DERIVED, never listed
 *
 * API Extractor's own convention is one `api-extractor.json` per entry point,
 * which here would be nineteen config files whose only real content is a path.
 * A hand-kept list of the public surface is exactly the thing that goes stale —
 * this repo has the receipts: turbo `inputs` globs that stopped matching, five
 * vitest project definitions duplicated at the root and silently drifted, a
 * `typedoc.json` entry-point list a new subpath has to remember to join.
 *
 * So the entry points come from `package.json#exports` at run time. A new
 * subpath export gets a report on its first run, and `--check` then fails until
 * that report is committed — which is the behaviour you want, because a new
 * subpath IS a public API change.
 *
 * ## Usage
 *
 *   node scripts/api-report.mjs           # write/refresh the reports + API.md
 *   node scripts/api-report.mjs --check   # fail if any of them is stale
 *
 * `--check` is what runs in `pnpm check` and CI. It needs `dist/*.d.ts`, so it
 * runs after the build, beside `check:publint` and `check:attw`.
 *
 * ## Why API Extractor brings its own TypeScript
 *
 * It is built on the JS TypeScript compiler API — the one TS 5/6 shipped, which
 * the TS 7 native compiler does not expose. This repo is on `typescript@7`, so
 * the module is resolved out of api-extractor's OWN dependency tree rather than
 * the workspace's. That is the same constraint `docs/` has (it pins its own
 * `typescript@6` for TypeDoc); the difference is that api-extractor bundles a
 * compatible compiler itself, so no second pin is needed here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

import {
  collectExportedNames,
  reportSource,
  stripPackageDocumentationMarker,
  typedEntryPoints,
} from "./_api-surface.mjs";
import { parseScriptArgs } from "./_args.mjs";
import { publishablePackages, readManifest, repoRoot } from "./_fs.mjs";

const require = createRequire(import.meta.url);
const { Extractor, ExtractorConfig, ExtractorLogLevel } = require("@microsoft/api-extractor");

const ROOT = repoRoot(import.meta.url).replace(/\/$/, "");
const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { check: { type: "boolean" } },
});
const CHECK = FLAGS.check === true;

/** The combined file: every entry point's report, in reading order. */
const COMBINED_FILE = "API.md";

/** The export-name lists: what each entry point exposes, without signatures. */
const EXPORTS_FILE = "API-EXPORTS.json";

// The `.d.ts` entry points of a package's `exports` map — and their SLUGS —
// live in `_api-surface.mjs` as `typedEntryPoints`. The scan and the slug rule
// were written here and again in `_api-contracts-tree.mjs`, and the two are
// coupled by a FILENAME: this script writes `etc/<slug>.api.md` and that one
// looks it back up. A divergence therefore surfaces as "missing report" naming
// a path nobody typed.

/**
 * Run API Extractor for one entry point.
 *
 * The config is built in memory rather than read from a file — see the header on
 * why there are no per-entry-point config files.
 */
function runExtractor(packageDir, entry, { write }) {
  const reportFolder = join(packageDir, "etc");
  const reportFileName = `${entry.slug}.api.md`;
  mkdirSync(reportFolder, { recursive: true });

  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: packageDir,
      mainEntryPointFilePath: join(packageDir, entry.types),
      // The report is the whole point; the rollup .d.ts and the doc model are
      // build outputs we do not consume, so they stay off.
      //
      // `reportTempFolder` is NOT optional in practice. In check mode API
      // Extractor writes the freshly-extracted report somewhere and diffs it
      // against the committed one; left unset, that "somewhere" resolved to the
      // package root, so `--check` littered twenty `<slug>.api.md` files beside
      // each package.json — untracked, byte-identical to the real ones, and
      // caught only because markdownlint then failed on them. Point it at a
      // gitignored scratch directory instead.
      apiReport: {
        enabled: true,
        reportFolder,
        reportFileName,
        reportTempFolder: join(packageDir, "node_modules/.cache/api-extractor"),
        // A type referenced by a public signature but not itself exported is
        // still part of the surface a consumer has to satisfy — they just have
        // no name to import it by. Left out of the report, changing one is
        // invisible in review even though it can break a build. TypeDoc's
        // `treatWarningsAsErrors` catches a subset (it covers `aai` and
        // `aai-ui` only, and never the three aai-cli build-hook subpaths), and
        // it fails the run rather than showing what moved.
        //
        // Included, each such type appears in the report as a bare `declare`
        // with no `export` keyword — which is also what keeps the committed
        // export lists honest, since those are collected from the `export`
        // modifier rather than from every declaration in the file.
        includeForgottenExports: true,
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      compiler: {
        // `skipLibCheck` in spirit: these are already-emitted declarations, and
        // the repo type-checks its sources separately. Without it, an error in a
        // third-party .d.ts fails a report about our own API.
        overrideTsconfig: {
          compilerOptions: {
            skipLibCheck: true,
            strict: true,
            target: "esnext",
            module: "preserve",
            moduleResolution: "bundler",
            // `dist` holds emitted declarations that import each other by
            // relative path with explicit extensions.
            allowImportingTsExtensions: true,
          },
        },
      },
      messages: {
        // Warnings are informational here and must not fail the gate. The two
        // that fire in volume are `ae-forgotten-export` (now RECORDED rather
        // than merely warned about — see `includeForgottenExports` above) and
        // `ae-missing-release-tag` (this repo does not use @public/@beta tags).
        // Failing on those would make this a second, noisier copy of the docs
        // gate instead of a signature diff.
        compilerMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
        extractorMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
        tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
      },
    },
    configObjectFullPath: join(packageDir, "api-extractor.virtual.json"),
    packageJsonFullPath: join(packageDir, "package.json"),
  });

  const result = Extractor.invoke(config, {
    // `localBuild: true` OVERWRITES the committed report; false compares
    // against it and reports a difference. That is exactly the write/check
    // split, so it is the only thing this flag controls.
    localBuild: write,
    showVerboseMessages: false,
    messageCallback: (message) => {
      // Handled: silences api-extractor's own console output so the only thing
      // this script prints is its own summary.
      message.handled = true;
    },
  });

  return {
    slug: entry.slug,
    subpath: entry.subpath,
    reportPath: relative(ROOT, join(reportFolder, reportFileName)),
    succeeded: result.succeeded,
    // Non-zero when the committed report does not match what was extracted.
    apiReportChanged: result.apiReportChanged,
  };
}

/**
 * The `.d.ts` rollup out of one report, without the per-file markdown wrapper.
 *
 * A report is a two-line preamble and then everything of substance inside a
 * single ```ts fence. Repeating that preamble twenty times in the combined file
 * would cost a reader twenty "Do not edit this file" lines and tell them
 * nothing; the heading this script writes instead says which entry point they
 * are looking at, which the preamble does not.
 *
 * A missing fence THROWS rather than yielding an empty section, because the
 * combined file's whole failure mode is being silently thin: `--check` compares
 * it against a freshly built copy, so twenty empty sections would agree with
 * twenty empty sections and the gate would pass.
 */
function rollupBody(reportPath) {
  const label = relative(ROOT, reportPath);
  const body = stripPackageDocumentationMarker(
    reportSource(readFileSync(reportPath, "utf8"), label),
  );
  if (body === "") throw new Error(`api-report: ${label} rolled up to nothing.`);
  return body;
}

/**
 * `API-EXPORTS.json`: every entry point's export NAMES, sorted.
 *
 * A second artifact over the same reports, and the split between them is the
 * point. A report answers "what is the shape of this API" and churns whenever a
 * parameter is widened, a doc comment moves, or an overload is added — which is
 * what a reviewer wants, and which also means a name quietly appearing or
 * disappearing is one line inside a hundred-line diff. This file answers only
 * "what is IN the surface", so adding an export is a one-line addition and
 * removing one is a one-line deletion, in both cases against a stable file.
 *
 * `sdk/exports.test.ts` pins some of the same names, and stays: a test fails at
 * the moment the surface moves and names the symbol, which is a different job
 * from being a reviewable fact in the diff. This covers every entry point,
 * where that test covers the ones somebody remembered to add.
 *
 * Forgotten exports are deliberately absent — `collectExportedNames` reads the
 * `export` modifier, so a type that appears in the report only because a public
 * signature mentions it is in the REPORT (where a change to it is reviewable)
 * and not in this list (which is about what a consumer can import by name).
 */
function exportsFile(sections) {
  const surface = {};
  for (const section of sections) {
    surface[section.specifier] = collectExportedNames(
      readFileSync(section.absolutePath, "utf8"),
      section.reportPath,
    );
  }
  return `${JSON.stringify(surface, null, 2)}\n`;
}

/** The specifier a consumer actually writes: `@alexkroman1/aai/stt`, not `./stt`. */
const importSpecifier = (packageName, subpath) =>
  subpath === "." ? packageName : `${packageName}/${subpath.replace(/^\.\//, "")}`;

/** Assemble `API.md` from the reports listed in `sections`. */
function combinedFile(sections) {
  const out = [
    "<!-- Generated by `pnpm api-report`. Do not edit — edit the source, then regenerate. -->",
    "",
    "# Public API surface",
    "",
    "Every published entry point of every publishable package, in one file, so the",
    "whole surface can be read in a single pass — which is what a coding agent",
    "needs and what the per-entry-point reports under `packages/*/etc/` are the",
    "wrong shape for. Those reports are still the artifact a REVIEWER reads: a",
    "signature change lands in the one that owns it, and `pnpm check:api-report`",
    "gates both.",
    "",
    "Sections are the reports verbatim, so anything true of them is true here —",
    "these are the rolled-up public `.d.ts` of each entry point, not prose, and a",
    "symbol exported from two subpaths appears under both.",
    "",
    "## Contents",
    "",
  ];
  for (const section of sections) {
    out.push(`- \`${section.specifier}\` — \`${section.reportPath}\``);
  }
  for (const section of sections) {
    out.push("", `## \`${section.specifier}\``, "", "```ts", section.body, "```");
  }
  return `${out.join("\n")}\n`;
}

const packages = publishablePackages(ROOT).map((dir) => join(ROOT, dir));
if (packages.length === 0) {
  console.error("api-report: found no publishable packages — is the scan still right?");
  process.exit(1);
}

const stale = [];
const missingDts = [];
const sections = [];
let reportCount = 0;

for (const packageDir of packages) {
  const manifest = readManifest(join(packageDir, "package.json"));
  const entries = typedEntryPoints(manifest);
  if (entries.length === 0) {
    console.error(
      `api-report: ${manifest.name} declares no .d.ts entry points — check its exports map.`,
    );
    process.exit(1);
  }

  for (const entry of entries) {
    if (!existsSync(join(packageDir, entry.types))) {
      missingDts.push(`${manifest.name} ${entry.subpath} -> ${entry.types}`);
      continue;
    }
    const outcome = runExtractor(packageDir, entry, { write: !CHECK });
    reportCount += 1;
    if (CHECK && outcome.apiReportChanged) {
      stale.push({ name: manifest.name, ...outcome });
    }
    sections.push({
      specifier: importSpecifier(manifest.name, entry.subpath),
      reportPath: outcome.reportPath,
      absolutePath: join(ROOT, outcome.reportPath),
    });
  }
}

if (missingDts.length > 0) {
  console.error("\napi-report: missing declaration files:\n");
  for (const entry of missingDts) console.error(`  ${entry}`);
  console.error("\nBuild first: `pnpm exec turbo run build`.\n");
  process.exit(1);
}

// The per-entry reports first, in both modes. In check mode they are also what
// the combined file is assembled FROM — `localBuild: false` leaves the committed
// copies untouched — so a stale report has to fail here rather than quietly
// making `API.md` agree with itself.
if (stale.length > 0) {
  console.error(`\napi-report: ${stale.length} API report(s) out of date:\n`);
  for (const { name, subpath, reportPath } of stale) {
    console.error(`  ${name} ${subpath}\n    ${reportPath}`);
  }
  console.error(
    "\nThe published type surface changed. Run `pnpm api-report` and commit the\n" +
      `updated file(s) plus ${COMBINED_FILE}, so the signature change lands in the diff a\n` +
      "reviewer sees. Then check the changeset bump type actually matches: a widened\n" +
      "parameter or a new optional field is a minor, a removed or narrowed one is a major.\n",
  );
  process.exit(1);
}

const derived = [
  {
    file: COMBINED_FILE,
    content: combinedFile(
      sections.map((section) => ({ ...section, body: rollupBody(section.absolutePath) })),
    ),
    explain:
      `It is the ${reportCount} per-entry-point reports concatenated — the whole published\n` +
      "surface in one file, for readers that want it in a single pass.",
  },
  {
    file: EXPORTS_FILE,
    content: exportsFile(sections),
    explain:
      "It is every entry point's export NAMES, sorted — the surface without the\n" +
      "signatures, so a symbol appearing or disappearing is a one-line diff even\n" +
      "when the reports around it churn.",
  },
];

if (!CHECK) {
  for (const { file, content } of derived) writeFileSync(join(ROOT, file), content);
  console.log(
    `api-report: wrote ${reportCount} report(s) under packages/*/etc/, ` +
      `${COMBINED_FILE} and ${EXPORTS_FILE}.`,
  );
  process.exit(0);
}

const outdated = derived.filter(({ file, content }) => {
  const path = join(ROOT, file);
  return (existsSync(path) ? readFileSync(path, "utf8") : null) !== content;
});

if (outdated.length > 0) {
  for (const { file, explain } of outdated) {
    const path = join(ROOT, file);
    console.error(
      `\napi-report: ${file} is ${existsSync(path) ? "out of date" : "missing"}.\n\n${explain}\n` +
        "Run `pnpm api-report` and commit it.\n",
    );
  }
  process.exit(1);
}

console.log(
  `api-report: ${reportCount} API report(s), ${COMBINED_FILE} and ${EXPORTS_FILE} up to date. ✓`,
);
