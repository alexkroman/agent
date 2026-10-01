#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.
/**
 * Measure a property suite's coverage floors over N runs and print the range
 * each counter actually reached — the "observed minimum across many runs"
 * `.agents/testing.md` asks a floor to sit under, and the recorded range
 * `scripts/check-property-floors.mjs` requires beside it.
 *
 *     pnpm floors:sample --runs 20 packages/aai-ui/src/session/fuzz-session.test.ts
 *     pnpm floors:sample packages/aai-runtime/src/integration/s2s-fuzz.integration.test.ts
 *
 * Each run is a fresh vitest process, so fast-check draws a fresh random seed
 * for every property that does not pin one (a pinned `seed` shows as a
 * zero-width range, which is what it is). The recording itself is
 * `scripts/record-floor-samples.mjs`, switched on by `AAI_FLOOR_SAMPLES`.
 * `*.integration.test.ts` files run through `vitest.slow.config.ts`, every
 * other file through the root config's projects.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseScriptArgs } from "./_args.mjs";
import { repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url);

const { values, positionals } = parseScriptArgs({
  script: import.meta.url,
  options: { runs: { type: "string" } },
  allowPositionals: true,
});
const runs = Number(values.runs ?? 10);
if (!Number.isInteger(runs) || runs < 1 || positionals.length === 0) {
  console.error("usage: node scripts/sample-property-floors.mjs [--runs N] <test file>...");
  process.exit(2);
}

const files = positionals.map((file) => path.relative(ROOT, path.resolve(file)));
const integration = files.filter((file) => file.includes(".integration.test."));
const unit = files.filter((file) => !integration.includes(file));

const dir = mkdtempSync(path.join(tmpdir(), "aai-floor-samples-"));
const vitest = path.join(ROOT, "node_modules/.bin/vitest");

/** Spawn one vitest run per selected group, appending samples to `out`. */
function runOnce(out) {
  let failed = false;
  const env = { ...process.env, AAI_FLOOR_SAMPLES: out };
  if (unit.length > 0) {
    const r = spawnSync(vitest, ["run", ...unit], { cwd: ROOT, env, stdio: "ignore" });
    failed ||= r.status !== 0;
  }
  if (integration.length > 0) {
    const r = spawnSync(vitest, ["run", "-c", "vitest.slow.config.ts"], {
      cwd: ROOT,
      env: { ...env, VITEST_PROFILE: "integration", VITEST_INCLUDE: integration.join(",") },
      stdio: "ignore",
    });
    failed ||= r.status !== 0;
  }
  return failed;
}

/** @type {Map<string, { file: string, test: string, label: string, matcher: string, floor: number, values: number[] }>} */
const counters = new Map();
let failedRuns = 0;
for (let i = 1; i <= runs; i++) {
  const out = path.join(dir, `run-${i}.jsonl`);
  process.stderr.write(`run ${i}/${runs}…\r`);
  if (runOnce(out)) failedRuns++;
  let text = "";
  try {
    text = readFileSync(out, "utf-8");
  } catch {
    continue;
  }
  /** Values from THIS run, so a floor asserted in a loop reports its own minimum. */
  const thisRun = new Map();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const sample = JSON.parse(line);
    const key = `${sample.file}\0${sample.test}\0${sample.label}\0${sample.matcher}\0${sample.floor}`;
    const prev = thisRun.get(key);
    thisRun.set(key, {
      ...sample,
      actual: Math.min(prev?.actual ?? Number.POSITIVE_INFINITY, sample.actual),
    });
  }
  for (const [key, sample] of thisRun) {
    const entry = counters.get(key) ?? { ...sample, values: [] };
    entry.values.push(sample.actual);
    counters.set(key, entry);
  }
}
rmSync(dir, { recursive: true, force: true });
process.stderr.write("\n");

if (counters.size === 0) {
  console.error(
    "sample-property-floors: no floor assertion was recorded. Check the paths, and that the\n" +
      "suite asserts its floors with toBeGreaterThan / toBeGreaterThanOrEqual on a number.",
  );
  process.exit(1);
}

let lastFile = "";
let lastTest = "";
for (const entry of [...counters.values()].sort((a, b) =>
  `${a.file}${a.test}`.localeCompare(`${b.file}${b.test}`),
)) {
  if (entry.file !== lastFile) {
    console.log(`\n${entry.file}`);
    lastFile = entry.file;
    lastTest = "";
  }
  const min = Math.min(...entry.values);
  const max = Math.max(...entry.values);
  const holds = entry.matcher.endsWith("OrEqual") ? min >= entry.floor : min > entry.floor;
  const verdict = holds ? "" : "  <-- floor is not under the observed minimum";
  if (entry.test !== lastTest) console.log(`  ${entry.test}`);
  lastTest = entry.test;
  console.log(`    ${entry.label || "(no message)"}`);
  console.log(
    `    floor ${entry.floor}; // Measured over ${entry.values.length} runs: ${min}-${max}.${verdict}`,
  );
}
if (failedRuns > 0)
  console.log(`\n${failedRuns} of ${runs} run(s) failed; their samples are included.`);
