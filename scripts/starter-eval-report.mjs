// Copyright 2026 the AAI authors. MIT license.
/**
 * Summarize starter-eval runs: a table per starter, and failure excerpts
 * grouped by signature so a recurring error is obvious at a glance.
 *
 *   node scripts/starter-eval-report.mjs <run.json> [baseline.json]
 *
 * With two files it diffs them, which is how a prompt or SDK change is
 * judged — a change is kept only if the numbers move.
 */

import { readFileSync } from "node:fs";

const load = (f) => JSON.parse(readFileSync(f, "utf-8"));

/** Collapse a diagnostic to a comparable signature (drop names/paths/numbers). */
function signature(text) {
  const ts = /error TS\d+: [^\n]{0,90}/.exec(text);
  const base = ts ? ts[0] : text.split("\n").find((l) => l.trim()) || text.slice(0, 80);
  return base
    .replace(/'[^']*'/g, "'X'")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);
}

function summarize(rows) {
  const ok = rows.filter((r) => !r.error);
  return {
    shippable: ok.filter((r) => r.shippable).length,
    green: ok.filter((r) => r.endedGreen).length,
    total: rows.length,
    toolCalls: ok.reduce((a, r) => a + (r.toolCalls ?? 0), 0),
    repairs: ok.reduce((a, r) => a + (r.failedTestAgentRuns ?? 0), 0),
    seconds: ok.reduce((a, r) => a + (r.seconds ?? 0), 0),
    harnessErrors: rows.filter((r) => r.error).length,
  };
}

const [file, baseFile] = process.argv.slice(2);
if (!file) throw new Error("usage: starter-eval-report.mjs <run.json> [baseline.json]");
const rows = load(file);
const base = baseFile ? load(baseFile) : undefined;
const baseBy = new Map((base ?? []).map((r) => [r.label, r]));

const pad = (s, n) => String(s).padEnd(n);
console.log(pad("starter", 46), pad("verdict", 8), pad("tools", 7), pad("repairs", 9), "secs");
console.log("-".repeat(80));
for (const r of rows) {
  if (r.error) {
    console.log(pad(r.label.slice(0, 44), 46), "HARNESS", r.error.slice(0, 60));
    continue;
  }
  const b = baseBy.get(r.label);
  const delta = (now, was) => (was === undefined ? "" : now === was ? " (=)" : ` (${was}→${now})`);
  console.log(
    pad(r.label.slice(0, 44), 46),
    pad(r.shippable ? "SHIP" : r.endedGreen ? "built" : "RED", 8),
    pad(`${r.toolCalls}${delta(r.toolCalls, b?.toolCalls)}`, 7),
    pad(`${r.failedTestAgentRuns}${delta(r.failedTestAgentRuns, b?.failedTestAgentRuns)}`, 9),
    r.seconds,
    (r.reasons ?? []).length ? ` [${r.reasons.join(" ")}]` : "",
  );
}

const s = summarize(rows);
console.log("-".repeat(80));
console.log(
  `TOTAL  shippable ${s.shippable}/${s.total}  built ${s.green}/${s.total}  toolCalls ${s.toolCalls}  repairs ${s.repairs}  ` +
    `${Math.round(s.seconds / 60)}min` +
    (s.harnessErrors ? `  harnessErrors ${s.harnessErrors}` : ""),
);
if (base) {
  const b = summarize(base);
  console.log(
    `BASE   green ${b.green}/${b.total}  toolCalls ${b.toolCalls}  repairs ${b.repairs}  ` +
      `${Math.round(b.seconds / 60)}min`,
  );
}

// Tool usage: a tool no run ever calls is context every session pays for
// and gets nothing back. `allTools` is the declared set, so zero-use tools
// are named rather than merely absent.
const used = new Map();
for (const r of rows) for (const t of r.tools ?? []) used.set(t, (used.get(t) ?? 0) + 1);
const declared = (process.env.AAI_TOOL_LIST ?? "").split(/[\s,]+/).filter(Boolean);
console.log("\nTOOL USAGE");
for (const [t, n] of [...used].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}x  ${t}`);
}
const never = declared.filter((t) => !used.has(t));
if (never.length) console.log(`  never called: ${never.join(", ")}`);

// Recurring failures are the tuning targets — one signature hitting several
// starters is worth a framework fix, not a wording tweak.
const bySig = new Map();
for (const r of rows) {
  for (const f of r.failures ?? []) {
    const sig = signature(f);
    if (!bySig.has(sig)) bySig.set(sig, { count: 0, starters: new Set(), sample: f });
    const e = bySig.get(sig);
    e.count++;
    e.starters.add(r.label.slice(0, 28));
  }
}
if (bySig.size) {
  console.log("\nFAILURE SIGNATURES (most common first)");
  for (const [sig, e] of [...bySig].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`\n  ${e.count}x  ${sig}`);
    console.log(`      starters: ${[...e.starters].join(", ")}`);
  }
}
