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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = new URL("..", import.meta.url).pathname;

export const REPORT_KIND = "aai-artifact-size-report";
export const REPORT_SCHEMA_VERSION = 1;

/** Fractional growth a single metric may show before the budget fails. */
export const SIZE_BUDGET_THRESHOLD = 0.1;

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

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith("--")) continue;
    const key = flag.slice(2);
    if (key === "help") {
      args.help = true;
      continue;
    }
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

export function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

export function formatSignedBytes(bytes) {
  if (bytes === 0) return "—";
  return `${bytes > 0 ? "+" : "-"}${formatBytes(Math.abs(bytes))}`;
}

function formatRatioPercent(ratio) {
  if (!Number.isFinite(ratio)) return "new";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Total bytes and file count of a directory tree. */
function measureTree(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      bytes += statSync(full).size;
      files += 1;
    }
  };
  walk(dir);
  return { bytes, files };
}

/** Publishable packages — the ones without `"private": true`. */
function publishablePackages() {
  return readdirSync(join(ROOT, "packages"))
    .map((dir) => join("packages", dir))
    .filter((dir) => {
      const manifestPath = join(ROOT, dir, "package.json");
      if (!existsSync(manifestPath)) return false;
      return JSON.parse(readFileSync(manifestPath, "utf8")).private !== true;
    })
    .sort();
}

/**
 * Pack a package and measure the tarball.
 *
 * Packing rather than measuring `dist/` is the point: `dist/` is not what ships.
 * `files`, `.npmignore` and the `prepack` script all sit between the two, and
 * every historical "we shipped the wrong thing" bug lives in that gap.
 */
function measurePackage(dir) {
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  const workDir = mkdtempSync(join(tmpdir(), "aai-size-"));
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", workDir], {
      cwd: join(ROOT, dir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarball = readdirSync(workDir).find((name) => name.endsWith(".tgz"));
    if (tarball === undefined) throw new Error(`pnpm pack produced no tarball for ${dir}`);
    const packedBytes = statSync(join(workDir, tarball)).size;

    const extractDir = join(workDir, "unpacked");
    mkdirSync(extractDir, { recursive: true });
    execFileSync("tar", ["-xzf", join(workDir, tarball), "-C", extractDir], { encoding: "utf8" });
    const unpacked = measureTree(join(extractDir, "package"));

    return {
      name: manifest.name,
      dir,
      packedBytes,
      unpackedBytes: unpacked.bytes,
      fileCount: unpacked.files,
      runtimeDependencies: Object.keys(manifest.dependencies ?? {}).sort(),
    };
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
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
// Markdown
// ---------------------------------------------------------------------------

function markdownTable(rows) {
  return rows.map((cells) => `| ${cells.join(" | ")} |`).join("\n");
}

/** A signed byte delta, or an em dash when there is no baseline row. */
function deltaCell(comparison) {
  return comparison ? formatSignedBytes(comparison.delta) : "—";
}

/** A signed count delta, or an em dash when unchanged or unavailable. */
function countDeltaCell(comparison) {
  if (!comparison || comparison.delta === 0) return "—";
  return `${comparison.delta > 0 ? "+" : ""}${comparison.delta}`;
}

function renderBundles(bundles) {
  const lines = ["", "### Bundles", ""];
  lines.push(
    markdownTable([
      ["Bundle", "Raw", "Δ", "Gzip", "Δ"],
      ["---", "---:", "---:", "---:", "---:"],
      ...bundles.map((b) => [
        `\`${b.name}\``,
        formatBytes(b.rawBytes),
        deltaCell(b.rawComparison),
        formatBytes(b.gzipBytes),
        deltaCell(b.gzipComparison),
      ]),
    ]),
  );
  for (const b of bundles) {
    if (b.note) lines.push("", `\`${b.name}\` — ${b.note}.`);
  }
  return lines;
}

function renderPackages(packages) {
  return [
    "",
    "### Published packages",
    "",
    markdownTable([
      ["Package", "Packed", "Δ", "Unpacked", "Δ", "Files", "Δ"],
      ["---", "---:", "---:", "---:", "---:", "---:", "---:"],
      ...packages.map((p) => [
        `\`${p.name}\``,
        formatBytes(p.packedBytes),
        deltaCell(p.packedComparison),
        formatBytes(p.unpackedBytes),
        deltaCell(p.unpackedComparison),
        String(p.fileCount),
        countDeltaCell(p.fileCountComparison),
      ]),
    ]),
  ];
}

function renderDependencyChanges(packages) {
  const changed = packages.filter(
    (p) => (p.addedDependencies?.length ?? 0) > 0 || (p.removedDependencies?.length ?? 0) > 0,
  );
  if (changed.length === 0) return [];
  const lines = ["", "### Runtime dependency changes", ""];
  for (const p of changed) {
    for (const d of p.addedDependencies ?? []) lines.push(`- **added** \`${p.name}\` → \`${d}\``);
    for (const d of p.removedDependencies ?? []) lines.push(`- removed \`${p.name}\` → \`${d}\``);
  }
  return lines;
}

function renderBudget(checks, hasBaseline) {
  if (checks.length === 0) return hasBaseline ? ["", "No budget regressions. ✓"] : [];
  const lines = ["", "### ⚠️ Budget", ""];
  for (const check of checks) {
    lines.push(
      check.kind === "runtime-dependency"
        ? `- New runtime dependency \`${check.dependency}\` in \`${check.package}\`. Runtime dependencies land in every consumer's tree — prefer bundling it or moving it to devDependencies.`
        : `- \`${check.metric}\` grew ${formatRatioPercent(check.increaseRatio)} (${formatBytes(check.baseline)} → ${formatBytes(check.current)}), over the ${formatRatioPercent(check.thresholdRatio)} limit.`,
    );
  }
  lines.push(
    "",
    "If the growth is intended, add the `acknowledge-size-warning` label. It is " +
      "removed automatically on the next push, so each commit is acknowledged on " +
      "its own.",
  );
  return lines;
}

export function renderMarkdown(report, comparison) {
  const label = comparison?.baselineLabel;
  return `${[
    "## Artifact size",
    label != null
      ? `Compared against \`${label}\`. A metric growing more than ${formatRatioPercent(SIZE_BUDGET_THRESHOLD)}, or a new runtime dependency, fails the budget.`
      : "_No baseline available — sizes are reported without a comparison._",
    ...renderBundles(comparison?.bundles ?? report.bundles),
    ...renderPackages(comparison?.packages ?? report.packages),
    ...renderDependencyChanges(comparison?.packages ?? report.packages),
    ...renderBudget(comparison?.checks ?? [], label != null),
  ].join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
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

  const report = {
    kind: REPORT_KIND,
    schemaVersion: REPORT_SCHEMA_VERSION,
    bundles: BUNDLES.map(measureBundle),
    packages: publishablePackages().map(measurePackage),
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
