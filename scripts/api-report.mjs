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
 *   node scripts/api-report.mjs           # write/refresh the reports
 *   node scripts/api-report.mjs --check   # fail if any report is stale
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

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

const require = createRequire(import.meta.url);
const { Extractor, ExtractorConfig } = require("@microsoft/api-extractor");

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CHECK = process.argv.includes("--check");

/** Publishable packages — the ones without `"private": true`. */
function publishablePackages() {
  return readdirSync(join(ROOT, "packages"))
    .map((dir) => join(ROOT, "packages", dir))
    .filter((dir) => {
      const manifest = join(dir, "package.json");
      return existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).private !== true;
    })
    .sort();
}

/**
 * The `.d.ts` entry points of one package's `exports` map.
 *
 * Skips three shapes that have no API to report: an asset (`./styles.css`), the
 * manifest itself (`./package.json`), and a wildcard subpath
 * (`./default-client/*`), which names a directory of built assets rather than a
 * module with a signature.
 */
function entryPoints(manifest) {
  const found = [];
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (subpath.includes("*")) continue;
    const types = typeof target === "string" ? target : target?.types;
    if (typeof types !== "string" || !types.endsWith(".d.ts")) continue;
    found.push({
      subpath,
      types,
      // "." -> "index"; "./stt" -> "stt"; "./default-client/x" -> "default-client-x".
      slug: subpath === "." ? "index" : subpath.replace(/^\.\//, "").replaceAll("/", "-"),
    });
  }
  return found.sort((a, b) => a.slug.localeCompare(b.slug));
}

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
        // that fire in volume are `ae-forgotten-export` (a type referenced by a
        // public signature but not itself exported — real, but it is TypeDoc's
        // `treatWarningsAsErrors` that already gates it) and
        // `ae-missing-release-tag` (this repo does not use @public/@beta tags).
        // Failing on those would make this a second, noisier copy of the docs
        // gate instead of a signature diff.
        compilerMessageReporting: { default: { logLevel: "none" } },
        extractorMessageReporting: { default: { logLevel: "none" } },
        tsdocMessageReporting: { default: { logLevel: "none" } },
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

const packages = publishablePackages();
if (packages.length === 0) {
  console.error("api-report: found no publishable packages — is the scan still right?");
  process.exit(1);
}

const stale = [];
const missingDts = [];
let reportCount = 0;

for (const packageDir of packages) {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const entries = entryPoints(manifest);
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
  }
}

if (missingDts.length > 0) {
  console.error("\napi-report: missing declaration files:\n");
  for (const entry of missingDts) console.error(`  ${entry}`);
  console.error("\nBuild first: `pnpm exec turbo run build`.\n");
  process.exit(1);
}

if (!CHECK) {
  console.log(`api-report: wrote ${reportCount} report(s) under packages/*/etc/.`);
  process.exit(0);
}

if (stale.length > 0) {
  console.error(`\napi-report: ${stale.length} API report(s) out of date:\n`);
  for (const { name, subpath, reportPath } of stale) {
    console.error(`  ${name} ${subpath}\n    ${reportPath}`);
  }
  console.error(
    "\nThe published type surface changed. Run `pnpm api-report` and commit the\n" +
      "updated file(s), so the signature change lands in the diff a reviewer sees.\n" +
      "Then check the changeset bump type actually matches: a widened parameter or\n" +
      "a new optional field is a minor, a removed or narrowed one is a major.\n",
  );
  process.exit(1);
}

console.log(`api-report: ${reportCount} API report(s) up to date. ✓`);
