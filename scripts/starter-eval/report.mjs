// Copyright 2026 the AAI authors. MIT license.
/**
 * Summarize starter-eval runs: a table per starter, and failure excerpts
 * grouped by signature so a recurring error is obvious at a glance.
 *
 *   node scripts/starter-eval/report.mjs <run.json> [baseline.json]
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
    red: ok.reduce((a, r) => a + (r.redChecks ?? 0), 0),
    seconds: ok.reduce((a, r) => a + (r.seconds ?? 0), 0),
    harnessErrors: rows.filter((r) => r.error).length,
  };
}

const [file, baseFile] = process.argv.slice(2);
if (!file) throw new Error("usage: starter-eval/report.mjs <run.json> [baseline.json]");
const rows = load(file);
const base = baseFile ? load(baseFile) : undefined;
const baseBy = new Map((base ?? []).map((r) => [r.label, r]));

const pad = (s, n) => String(s).padEnd(n);
// `red` is a headline column, not a footnote: post-write type diagnostics
// moved errors upstream of `test_agent`, so `repairs` now sits at zero on a
// healthy run and has no variance left to report. Red verifications are what
// still separate a run that got it right from one that got there eventually.
console.log(
  pad("starter", 46),
  pad("verdict", 8),
  pad("tools", 7),
  pad("red", 6),
  pad("repairs", 9),
  "secs",
);
console.log("-".repeat(86));
for (const r of rows) {
  if (r.error) {
    console.log(pad(r.label.slice(0, 44), 46), "HARNESS", r.error.slice(0, 60));
    continue;
  }
  const b = baseBy.get(r.label);
  const delta = (now, was) => {
    if (was === undefined) return "";
    return now === was ? " (=)" : ` (${was}→${now})`;
  };
  const verdict = (row) => {
    if (row.shippable) return "SHIP";
    return row.endedGreen ? "built" : "RED";
  };
  console.log(
    pad(r.label.slice(0, 44), 46),
    pad(verdict(r), 8),
    pad(`${r.toolCalls}${delta(r.toolCalls, b?.toolCalls)}`, 7),
    pad(`${r.redChecks ?? 0}${delta(r.redChecks, b?.redChecks)}`, 6),
    pad(`${r.failedTestAgentRuns}${delta(r.failedTestAgentRuns, b?.failedTestAgentRuns)}`, 9),
    r.seconds,
    (r.reasons ?? []).length > 0 ? ` [${r.reasons.join(" ")}]` : "",
  );
}

const s = summarize(rows);
console.log("-".repeat(86));
console.log(
  `TOTAL  shippable ${s.shippable}/${s.total}  built ${s.green}/${s.total}  toolCalls ${s.toolCalls}  ` +
    `red ${s.red}  repairs ${s.repairs}  ${Math.round(s.seconds / 60)}min` +
    (s.harnessErrors ? `  harnessErrors ${s.harnessErrors}` : ""),
);
if (base) {
  const b = summarize(base);
  console.log(
    `BASE   green ${b.green}/${b.total}  toolCalls ${b.toolCalls}  red ${b.red}  repairs ${b.repairs}  ` +
      `${Math.round(b.seconds / 60)}min`,
  );
}

// Tool usage: a tool no run ever calls is context every session pays for and
// gets nothing back. Only tools that WERE called can be listed — a run records
// the calls it made, not the set it was offered — so read a missing tool as
// "no run reached for it", and check it against the guest's tool set by hand.
const used = new Map();
for (const r of rows) for (const t of r.tools ?? []) used.set(t, (used.get(t) ?? 0) + 1);
console.log("\nTOOL USAGE");
for (const [t, n] of [...used].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}x  ${t}`);
}

// Recurring diagnostics are the tuning targets — one signature hitting several
// starters is worth a framework fix, not a wording tweak.
function groupSignatures(pick) {
  const bySig = new Map();
  for (const r of rows) {
    for (const f of pick(r) ?? []) {
      const sig = signature(f);
      if (!bySig.has(sig)) bySig.set(sig, { count: 0, starters: new Set(), sample: f });
      const e = bySig.get(sig);
      e.count++;
      e.starters.add(r.label.slice(0, 28));
    }
  }
  return [...mergeTruncated(bySig)].sort((a, b) => b[1].count - a[1].count);
}

/**
 * Fold a signature that is a strict prefix of a longer one into that one.
 *
 * Excerpts are length-capped, so the SAME diagnostic cut at two different
 * points yields two signatures — and the section exists to show that a
 * diagnostic recurs. Unmerged, one error hitting three starters reads as three
 * unrelated one-offs, which is the opposite of the conclusion.
 */
function mergeTruncated(bySig) {
  const sigs = [...bySig.keys()].sort((a, b) => b.length - a.length);
  const merged = new Map();
  for (const sig of sigs) {
    const into = [...merged.keys()].find((k) => k.startsWith(sig));
    const entry = bySig.get(sig);
    if (into === undefined) {
      merged.set(sig, { ...entry, starters: new Set(entry.starters) });
      continue;
    }
    const target = merged.get(into);
    target.count += entry.count;
    for (const s of entry.starters) target.starters.add(s);
  }
  return merged;
}

function printSignatures(title, groups) {
  if (groups.length === 0) return;
  console.log(`\n${title} (most common first)`);
  for (const [sig, e] of groups) {
    console.log(`\n  ${e.count}x  ${sig}`);
    console.log(`      starters: ${[...e.starters].join(", ")}`);
  }
}

printSignatures(
  "FAILURE SIGNATURES",
  groupSignatures((r) => r.failures),
);

// Red verifications, which FAILURE SIGNATURES cannot show: it reads only
// test_agent failures, so a healthy run prints an empty section while the
// agent fixed a dozen type errors on the way there. Those are now where the
// cost is, so they get their own grouping.
printSignatures(
  "RED VERIFICATION SIGNATURES",
  groupSignatures((r) => r.redExcerpts),
);
