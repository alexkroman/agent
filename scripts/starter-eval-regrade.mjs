// Copyright 2026 the AAI authors. MIT license.
/**
 * Re-grade saved eval runs with the CURRENT expectations.
 *
 * The grader has been wrong four times now, and each correction lands after
 * the runs it should have applied to. Comparing an old dataset graded by the
 * old rules against a new one graded by the new rules measures the grader, not
 * the change under test — so every reported number goes through this first.
 *
 * Only the checks that can be recomputed from what a run saved are redone:
 * capability coverage, which reads the agent source. Mode, UI, and build
 * verdicts are taken as recorded.
 *
 *   node scripts/starter-eval-regrade.mjs /tmp/eval-iter5.json /tmp/eval-iter6.json
 */

import { readFileSync } from "node:fs";
import { checkCapabilities, checkUi, EXPECTATIONS } from "./starter-expectations.mjs";

/** Reasons this script recomputes; anything else is carried through as-is. */
const RECOMPUTED = /^missing:|^no client\.tsx|shows no live state/;

function regrade(run) {
  const expectation = EXPECTATIONS.find((e) => e.label === run.label);
  const source = run.files?.["agent.ts"];
  if (!expectation || source === undefined) return run;
  const { missing } = checkCapabilities(expectation, { config: null, source });
  const ui = checkUi(expectation, run.files);
  const reasons = (run.reasons ?? []).filter((r) => !RECOMPUTED.test(r));
  if (missing.length > 0) reasons.push(`missing:${missing.join("/")}`);
  if (!ui.ok && ui.note) reasons.push(ui.note);
  return { ...run, reasons, shippable: reasons.length === 0 };
}

function summarize(file) {
  const runs = JSON.parse(readFileSync(file, "utf8")).map(regrade);
  const shippable = runs.filter((r) => r.shippable).length;
  const calls = runs.reduce((n, r) => n + (r.tools?.length ?? 0), 0);
  const repairs = runs.reduce((n, r) => n + (r.failures?.length ?? 0), 0);
  // `firstTryClean` is absent on runs recorded before the counter existed;
  // report it only where it was actually measured rather than guessing.
  const measured = runs.filter((r) => r.firstTryClean !== undefined);
  const clean = measured.filter((r) => r.firstTryClean).length;
  const seconds = runs.reduce((n, r) => n + (Number.isFinite(r.seconds) ? r.seconds : 0), 0);
  console.log(`\n${file}`);
  console.log(
    `  shippable ${shippable}/${runs.length}   tool calls ${calls}   ` +
      `repairs ${repairs}   ${Math.round(seconds / 60)} min` +
      (measured.length > 0 ? `   first-try clean ${clean}/${measured.length}` : ""),
  );
  for (const r of runs.filter((x) => !x.shippable)) {
    console.log(`  FAIL ${r.label} — ${(r.reasons ?? []).join(" | ") || "(no reason recorded)"}`);
  }
}

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("usage: starter-eval-regrade.mjs <results.json>...");
for (const f of files) summarize(f);
