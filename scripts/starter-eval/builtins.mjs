// Copyright 2026 the AAI authors. MIT license.
/**
 * How often do generated agents reach for each opt-in builtin — and do they
 * do it UNPROMPTED?
 *
 * The question this answers is whether a builtin belongs in
 * `DEFAULT_BUILTIN_TOOLS`. That set applies to every deployed voice agent,
 * so each addition costs tool schema on every LLM turn and dilutes tool
 * choice; it earns that only if agents want it broadly.
 *
 * Unprompted adoption is the signal. A builtin declared only when the
 * starter prompt names it tells you the agent followed an instruction, not
 * that the capability is generally wanted — and adding it by default would
 * merely make an eval check pass while changing nothing for users.
 *
 *   node scripts/starter-eval-builtins.mjs run.json [more.json ...]
 *
 * Reads the workspaces the harness captured. It captures them for EVERY run,
 * shippable or not, which is what makes these totals rather than a lower
 * bound — the runs that SUCCEEDED are exactly the ones whose unprompted
 * choices the question is about, and the harness used to drop them.
 */

import { readFileSync } from "node:fs";
import { EXPECTATIONS } from "./starter-expectations.mjs";

const OPT_IN = ["web_search", "visit_webpage", "get_page_design", "fetch_json", "run_code"];

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("usage: starter-eval-builtins.mjs run.json [...]");

const rows = files.flatMap((f) => JSON.parse(readFileSync(f, "utf-8")));

/** Did the starter's own prompt name this builtin? */
function promptNamed(label, builtin) {
  const e = EXPECTATIONS.find((x) => x.label === label);
  return (e?.builtins ?? []).includes(builtin);
}

const stats = new Map(OPT_IN.map((b) => [b, { prompted: 0, unprompted: 0, absentWhenAsked: 0 }]));
let withSource = 0;

for (const r of rows) {
  const source = r.files?.["agent.ts"];
  if (source === undefined) continue; // shippable runs keep no snapshot
  withSource++;
  for (const b of OPT_IN) {
    const declared = source.includes(b);
    const asked = promptNamed(r.label, b);
    const s = stats.get(b);
    if (declared && asked) s.prompted++;
    else if (declared) s.unprompted++;
    else if (asked) s.absentWhenAsked++;
  }
}

console.log(`workspaces with source: ${withSource} of ${rows.length} runs`);
console.log("(only non-shippable runs keep a snapshot, so these are lower bounds)\n");
console.log("builtin".padEnd(18), "unprompted", " prompted", " asked-but-absent");
for (const [b, s] of stats) {
  console.log(
    b.padEnd(18),
    String(s.unprompted).padStart(10),
    String(s.prompted).padStart(9),
    String(s.absentWhenAsked).padStart(17),
  );
}
console.log(
  "\nA default is justified by UNPROMPTED adoption. High 'asked-but-absent' is an" +
    "\ninstruction-following problem, which a default would hide rather than fix.",
);
