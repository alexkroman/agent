#!/usr/bin/env node

/**
 * Measure the artifacts this repo actually ships, and diff them against a
 * baseline.
 *
 * ## What was here before
 *
 * `.size-limit.json` — two entries, `aai` at 30 kB and `aai-ui` at 25 kB. It
 * was referenced by no script, no turbo task, and no CI job, and `size-limit`
 * was not even a devDependency. Dead from the day it was added, in the same
 * genre as the `ls-lint` config no pipeline ran and the `.turbo` cache path
 * that never matched `cacheDir`. Its two limits were also both wrong: `aai`'s
 * `dist` is 1.7 MB.
 *
 * ## What is measured now, and why these things
 *
 *   * `aai-guest/dist/harness.mjs`. **13 MB, watched by nothing.** It is a
 *     single self-contained bundle (tsdown inlines every npm dependency) that
 *     gets baked into the Modal guest snapshot image, so its size is on the
 *     cold-start path of every sandbox the platform starts. Nothing else in the
 *     repo has that property and nothing was looking at it.
 *   * The three published tarballs — packed bytes, unpacked bytes, file count.
 *     Packed bytes are what a user waits for on `npm install`; unpacked bytes
 *     are what they carry on disk; the file count catches a `files` glob that
 *     started matching a directory it should not (the failure that ships tests,
 *     fixtures, or a stray `.tgz`).
 *   * Each published package's RUNTIME dependency list. A new entry here is the
 *     most expensive kind of growth — it is transitive, it lands in every
 *     consumer's tree, and it is the one form of bloat a byte threshold reads
 *     as small (a 4 kB wrapper pulling 2 MB of deps). So a new runtime
 *     dependency fails the budget on its own, regardless of size.
 *
 * Gzip is reported alongside raw for the harness because the Modal image layer
 * is compressed; the tarballs are already gzip, so their "packed" figure IS the
 * compressed one.
 *
 * ## Usage
 *
 *   node scripts/artifact-size-report.mjs \
 *     --output-json report.json [--output-markdown report.md] \
 *     [--baseline-json base.json --baseline-label "main (abc1234)"]
 *
 * With no baseline it just reports, which is what a local run wants. The
 * comparison — and therefore the budget — needs a baseline built from the PR's
 * base commit; `.github/workflows/artifact-size.yml` does that in a
 * `git worktree`. Enforcement lives in `artifact-size-budget.mjs` so the
 * workflow can post the comment BEFORE failing: a budget failure whose numbers
 * you have to dig out of a log is a worse version of the same information.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { publishablePackages, readManifest, repoRoot, withPackedTarball } from "./_fs.mjs";
import {
  REPORT_KIND,
  REPORT_SCHEMA_VERSION,
  SIZE_BUDGET_THRESHOLD,
} from "./artifact-size-format.mjs";
import { renderMarkdown } from "./artifact-size-markdown.mjs";

const ROOT = repoRoot(import.meta.url);

/**
 * The one bundle that is not a published package: the guest harness.
 *
 * Declared by path rather than discovered, because "the file baked into the
 * Modal image" is a fact about `aai-server`'s image build (`modal_image.py` +
 * `ensure-guest-harness.mjs`), not something the filesystem says.
 */
const BUNDLES = [
  {
    name: "aai-guest/harness.mjs",
    path: "packages/aai-guest/dist/harness.mjs",
    note: "baked into the Modal guest snapshot image — on every sandbox's cold-start path",
  },
];

/** Measured: 3 (`aai`, `aai-ui`, `aai-cli`). See the floor's note in `main`. */
const MIN_PUBLISHABLE_PACKAGES = 4;

/**
 * The options this accepts, for `node:util`'s `parseArgs`.
 *
 * Declared rather than inferred from argv, which is the whole reason the
 * hand-rolled loop this replaced is gone. That loop read only the
 * space-separated form, so `--output-json=/tmp/r.json` set a key literally
 * named `output-json=/tmp/r.json` and left `args["output-json"]` undefined —
 * the script then measured every artifact, printed the report to stdout, wrote
 * NO FILE and exited 0. `strict` also makes a misspelled flag an error instead
 * of a silently absorbed one.
 *
 * `@satisfies`, never `@type`: it checks the shape against node's own config
 * type while PRESERVING the literal `"string"` / `"boolean"` inference, which
 * is what lets `parseArgs` hand back `string | undefined` per flag. `@type`
 * widens those literals, every value comes back
 * `string | boolean | (string | boolean)[]`, and each use pays for a narrowing.
 *
 * @satisfies {import("node:util").ParseArgsOptionsConfig}
 */
const OPTIONS = {
  help: { type: "boolean" },
  "output-json": { type: "string" },
  "output-markdown": { type: "string" },
  "baseline-json": { type: "string" },
  "baseline-label": { type: "string" },
};

/**
 * Total bytes and file count of a directory tree.
 *
 * `readdirSync`'s `recursive` option, NOT `fs.globSync("**\/*")`: glob skips
 * any path segment starting with a dot, and a size budget that silently omits
 * dotfiles is the exact failure this repo keeps finding — a measurement that
 * looks like a measurement and undercounts. `isFile()` still filters, because
 * a symlink or a fifo has no size worth adding and `guard-invariants` rule 1
 * bans the former anyway.
 */
function measureTree(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    bytes += statSync(join(entry.parentPath, entry.name)).size;
    files += 1;
  }
  return { bytes, files };
}

/**
 * Pack a package and measure the tarball.
 *
 * Packing rather than measuring `dist/` is the point: `dist/` is not what ships.
 * `files`, `.npmignore` and the `prepack` script all sit between the two, and
 * every historical "we shipped the wrong thing" bug lives in that gap.
 */
function measurePackage(dir) {
  const manifest = readManifest(join(ROOT, dir, "package.json"));
  // The pack + scratch-directory dance is `_fs.mjs`'s, shared with
  // `check-publish-protocols.mjs` — the only two things in the repo that pack.
  return withPackedTarball(join(ROOT, dir), ({ tarball, workDir }) => {
    const packedBytes = statSync(tarball).size;
    const extractDir = join(workDir, "unpacked");
    mkdirSync(extractDir, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { encoding: "utf8" });
    const unpacked = measureTree(join(extractDir, "package"));

    return {
      name: manifest.name,
      dir,
      packedBytes,
      unpackedBytes: unpacked.bytes,
      fileCount: unpacked.files,
      runtimeDependencies: Object.keys(manifest.dependencies ?? {}).sort(),
    };
  });
}

function measureBundle({ name, path, note }) {
  const full = join(ROOT, path);
  if (!existsSync(full)) {
    throw new Error(
      `${path} does not exist. Build it first — \`node scripts/ensure-guest-harness.mjs\` ` +
        "or `pnpm --filter aai-guest build`.",
    );
  }
  const raw = readFileSync(full);
  return {
    name,
    path,
    note,
    rawBytes: raw.byteLength,
    // level 9: the report should describe the smallest the artifact can be, not
    // whatever this Node version's default happens to be — the default has
    // changed between releases and would show up as a phantom regression.
    gzipBytes: gzipSync(raw, { level: 9 }).byteLength,
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compareMetric(current, baseline) {
  const delta = current - baseline;
  let increaseRatio = 0;
  if (delta > 0) increaseRatio = baseline <= 0 ? Number.POSITIVE_INFINITY : delta / baseline;
  return { baseline, current, delta, increaseRatio };
}

/**
 * Build the comparison, including the budget checks the budget script enforces.
 *
 * The checks are computed HERE, next to the numbers, so the markdown a reviewer
 * reads and the pass/fail a job produces cannot disagree — they are the same
 * field of the same JSON.
 */
/** A size check, or nothing when the metric is inside the threshold. */
function sizeCheck(metric, comparison) {
  if (comparison.increaseRatio <= SIZE_BUDGET_THRESHOLD) return [];
  return [{ kind: "size", metric, ...comparison, thresholdRatio: SIZE_BUDGET_THRESHOLD }];
}

/** Index a baseline's rows by name, tolerating a baseline with none. */
function byName(rows) {
  return new Map((rows ?? []).map((row) => [row.name, row]));
}

/** One bundle row, with its comparisons and checks if a baseline row exists. */
function compareBundle(bundle, base) {
  if (base === undefined) return { row: { ...bundle }, checks: [] };
  const rawComparison = compareMetric(bundle.rawBytes, base.rawBytes);
  const gzipComparison = compareMetric(bundle.gzipBytes, base.gzipBytes);
  return {
    row: { ...bundle, rawComparison, gzipComparison },
    checks: [
      ...sizeCheck(`${bundle.name} raw`, rawComparison),
      ...sizeCheck(`${bundle.name} gzip`, gzipComparison),
    ],
  };
}

/** One package row, with its comparisons, dependency delta, and checks. */
function comparePackage(pkg, base) {
  if (base === undefined) return { row: { ...pkg }, checks: [] };

  const packedComparison = compareMetric(pkg.packedBytes, base.packedBytes);
  const unpackedComparison = compareMetric(pkg.unpackedBytes, base.unpackedBytes);
  const fileCountComparison = compareMetric(pkg.fileCount, base.fileCount);

  const baseDeps = new Set(base.runtimeDependencies ?? []);
  const addedDependencies = pkg.runtimeDependencies.filter((d) => !baseDeps.has(d));
  const removedDependencies = (base.runtimeDependencies ?? []).filter(
    (d) => !pkg.runtimeDependencies.includes(d),
  );

  return {
    row: {
      ...pkg,
      packedComparison,
      unpackedComparison,
      fileCountComparison,
      addedDependencies,
      removedDependencies,
    },
    checks: [
      ...sizeCheck(`${pkg.name} packed`, packedComparison),
      ...sizeCheck(`${pkg.name} unpacked`, unpackedComparison),
      // A new runtime dependency fails on its own. It is transitive, it lands
      // in every consumer's tree, and a byte threshold reads it as small: a
      // 4 kB wrapper can pull 2 MB behind it.
      ...addedDependencies.map((dependency) => ({
        kind: "runtime-dependency",
        package: pkg.name,
        dependency,
      })),
    ],
  };
}

export function compareReports(current, baselineReport, baselineLabel) {
  const baseBundles = byName(baselineReport?.bundles);
  const basePackages = byName(baselineReport?.packages);

  const bundleResults = current.bundles.map((b) => compareBundle(b, baseBundles.get(b.name)));
  const packageResults = current.packages.map((p) => comparePackage(p, basePackages.get(p.name)));

  return {
    baselineLabel: baselineLabel ?? null,
    bundles: bundleResults.map((r) => r.row),
    packages: packageResults.map((r) => r.row),
    checks: [...bundleResults, ...packageResults].flatMap((r) => r.checks),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { values: args } = parseArgs({ options: OPTIONS, strict: true });
  if (args.help) {
    process.stdout.write(
      [
        "Usage: node scripts/artifact-size-report.mjs [options]",
        "",
        "  --output-json <path>       write the machine-readable report",
        "  --output-markdown <path>   write the PR-comment markdown",
        "  --baseline-json <path>     a report to compare against",
        "  --baseline-label <text>    how to name the baseline in the markdown",
        "",
      ].join("\n"),
    );
    return;
  }

  // FLOOR the scan. `_fs.mjs` documents that the caller is expected to ("an
  // empty list means the scan stopped matching, never that the repo publishes
  // nothing") and `api-report.mjs` does; this caller did not, so a rename under
  // `packages/` produced a report with zero packages, a budget comparison over
  // nothing, and "no regressions ✓" at exit 0 — verified twice, once by
  // hand-building a degenerate report and running it through
  // `artifact-size-budget.mjs`. FOUR today — `aai`, `aai-cli`, `aai-runtime`
  // and `aai-ui`, the fixed release group — and the number is stable: it moves
  // only when this repo starts or stops publishing something. It read `three`
  // while the set was already four, which is the floor drifting loose rather
  // than breaking: a scan that stopped finding one package would still clear a
  // floor set below the real count.
  const packages = publishablePackages(ROOT);
  if (packages.length < MIN_PUBLISHABLE_PACKAGES) {
    throw new Error(
      `artifact-size-report: found ${packages.length} publishable package(s), below the ` +
        `floor of ${MIN_PUBLISHABLE_PACKAGES}. The scan has stopped matching — a budget ` +
        "report over an empty package list compares nothing and passes.",
    );
  }

  const report = {
    kind: REPORT_KIND,
    schemaVersion: REPORT_SCHEMA_VERSION,
    bundles: BUNDLES.map(measureBundle),
    packages: packages.map(measurePackage),
  };

  let baselineReport;
  if (args["baseline-json"] !== undefined) {
    baselineReport = JSON.parse(readFileSync(args["baseline-json"], "utf8"));
    if (baselineReport.kind !== REPORT_KIND) {
      throw new Error(
        `baseline report has kind "${baselineReport.kind}", expected "${REPORT_KIND}"`,
      );
    }
  }

  const comparison =
    baselineReport === undefined
      ? undefined
      : compareReports(report, baselineReport, args["baseline-label"]);
  if (comparison !== undefined) report.comparison = comparison;

  if (args["output-json"] !== undefined) {
    mkdirSync(dirname(args["output-json"]), { recursive: true });
    writeFileSync(args["output-json"], `${JSON.stringify(report, null, 2)}\n`);
  }

  const markdown = renderMarkdown(report, comparison);
  if (args["output-markdown"] !== undefined) {
    mkdirSync(dirname(args["output-markdown"]), { recursive: true });
    writeFileSync(args["output-markdown"], markdown);
  }

  process.stdout.write(markdown);
}

// Importable (the budget script reuses the formatters and the threshold), but
// only measures when invoked directly. Compared as resolved file URLs rather
// than by basename — a basename match would also fire when some other script of
// the same name imported this one.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
