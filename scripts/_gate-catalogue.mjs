// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate catalogue in `.agents/ratchets.md`, GENERATED from `check.mjs`'s
 * `GATES` table: `node scripts/check.mjs --catalogue print|write|check`
 * (`pnpm sync:gate-catalogue`, `pnpm check:gate-catalogue`).
 *
 * The hand-kept catalogue drifted the way every hand-kept list here does — it
 * covered a fraction of the rows and counted the baseline gates wrong — so the
 * table between the markers is derived, and `check` also fails on a gate the
 * prose OUTSIDE the markers never names, so every row has its "why" written
 * down somewhere a reader of the doc will find it.
 *
 * The block is run through prettier with the repo's own config before it is
 * compared or written, so `check:prettier` and this gate cannot disagree about
 * column padding.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as prettier from "prettier";

import { readJson } from "./_fs.mjs";

const DOC = ".agents/ratchets.md";
const START = "<!-- gate-catalogue:start (generated: pnpm sync:gate-catalogue) -->";
const END = "<!-- gate-catalogue:end -->";

/**
 * The catalogue table, one row per gate in table order.
 *
 * @param {{ script: string, phase: string, fatal: boolean, fix?: string, mode?: string }[]} gates
 * @param {Record<string, string>} scripts The root manifest's `scripts`.
 */
function renderCatalogue(gates, scripts) {
  const cell = (text) => text.replaceAll("|", "\\|");
  const rows = gates.map((gate) =>
    [
      `\`${gate.script}\``,
      gate.phase,
      gate.fatal ? "stops the run" : "reported at the end",
      gate.mode ?? "both",
      `\`${cell(scripts[gate.script] ?? "(missing from package.json)")}\``,
      gate.fix === undefined ? "—" : `\`pnpm ${gate.fix}\``,
    ].join(" | "),
  );
  return [
    "| Gate | Phase | Failure | Mode | Runs | Fix |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}

/**
 * The prose OUTSIDE the block is where a gate's reason lives; a row it never
 * names is a gate nobody wrote the "why" for.
 *
 * @param {string} prose
 * @param {{ script: string }[]} gates
 */
function undescribed(prose, gates) {
  return gates
    .filter((g) => !(prose.includes(`\`${g.script}\``) || prose.includes(`\`pnpm ${g.script}\``)))
    .map((g) => `${g.script} is in the GATES table but ${DOC} never describes it`);
}

/**
 * Print, write or check the catalogue. Returns the exit code.
 *
 * @param {{ root: string, gates: { script: string, phase: string, fatal: boolean, fix?: string, mode?: string }[], action: string }} options
 */
export async function runCatalogue({ root, gates, action }) {
  if (!["print", "write", "check"].includes(action)) {
    console.error(`check: --catalogue takes print, write or check, not "${action}".`);
    return 2;
  }
  const path = join(root, DOC);
  const manifest = /** @type {{ scripts?: Record<string, string> }} */ (
    readJson(join(root, "package.json"))
  );
  const scripts = manifest.scripts ?? {};
  const table = renderCatalogue(gates, scripts);
  if (action === "print") {
    console.log(table);
    return 0;
  }

  const current = readFileSync(path, "utf8");
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    console.error(`check-gate-catalogue: ${DOC} has no ${START} … ${END} block.`);
    return 1;
  }
  const spliced = `${current.slice(0, start + START.length)}\n\n${table}\n\n${current.slice(end)}`;
  const config = (await prettier.resolveConfig(path)) ?? {};
  const next = await prettier.format(spliced, { ...config, filepath: path });

  if (action === "write") {
    if (next !== current) writeFileSync(path, next);
    console.log(
      `check-gate-catalogue: ${DOC} ${next === current ? "already current" : "updated"} — ${gates.length} gate(s). ✓`,
    );
    return 0;
  }

  const problems = [
    ...(next === current ? [] : [`the generated table in ${DOC} is stale`]),
    ...undescribed(current.slice(0, start) + current.slice(end), gates),
  ];
  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-gate-catalogue: ${problem}`);
    console.error("Run `pnpm sync:gate-catalogue`, and describe any new gate in the doc's prose.");
    return 1;
  }
  console.log(`check-gate-catalogue: ${gates.length} gate(s), catalogue current. ✓`);
  return 0;
}
