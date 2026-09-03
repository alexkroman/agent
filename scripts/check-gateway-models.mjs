// Copyright 2026 the AAI authors. MIT license.
/**
 * Is the committed gateway catalog still what the gateway says?
 *
 * Regenerates from `/v1/models` (both regions, plus a liveness probe per
 * model) and diffs against the checked-in file, rather than re-implementing
 * the probe — two implementations of "which models exist" is how the list got
 * wrong in the first place.
 *
 * Deliberately NOT in CI: it spends (a trivial amount of) real tokens on the
 * caller's own key and depends on a third-party service being reachable, so a
 * gateway blip would redden unrelated pull requests. Run it when adding a
 * model, when one misbehaves, and periodically — a model going away is
 * invisible until someone selects it.
 *
 *   pnpm check:gateway-models
 *
 * Exits non-zero when the catalog is out of date; regenerate with
 * `node scripts/gen-gateway-models.mjs --write`.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TARGET = new URL("../packages/aai/src/sdk/providers/llm/gateway-models.ts", import.meta.url);
const GENERATOR = new URL("./gen-gateway-models.mjs", import.meta.url);

const fresh = execFileSync(process.execPath, [GENERATOR.pathname], { encoding: "utf-8" });
const committed = readFileSync(TARGET, "utf-8");

/**
 * The floor under both parses. ~50 models are advertised today.
 *
 * This gate had NO floor, and it is the one where that is worst: its whole
 * success line is a pair of counts, so a parse that stopped matching drops the
 * committed AND the generated map to zero, the diff between two empty maps is
 * empty, and it prints `catalog current — 0 advertised, 0 usable ✓`. The
 * regression it exists to catch is a model silently removed from the gateway,
 * which its own closing line says "reaches users as a retried 500, not a clear
 * error" — so a blind pass here is indistinguishable from the healthiest
 * possible catalog.
 */
const MIN_MODELS = 15;

/**
 * Compare the model DATA, not the file bytes. The committed copy is
 * biome-formatted and the generator's output is not, so a byte comparison
 * reports a difference on every run and teaches everyone to ignore it.
 *
 * `(\{(?:[^{}]|\{[^{}]*\})*\})` and not `\{[^}]*\}`: the flat class cannot
 * cross a NESTED `}`, so one entry gaining a nested object would silently drop
 * every entry after it on that line — and, since both sides are parsed the same
 * way, would drop both maps together rather than reporting a diff.
 */
const entries = (text) =>
  new Map(
    [...text.matchAll(/^\s*"([^"]+)": (\{(?:[^{}]|\{[^{}]*\})*\}),$/gm)].map(([, id, info]) => [
      id,
      info
        // Biome rewrites `200000` as `200_000` and adds a trailing comma, so
        // normalize both — otherwise the check reports a difference on every
        // run and everyone learns to ignore it.
        .replace(/(\d)_(\d)/g, "$1$2")
        .replace(/,\s*\}/, " }")
        .replace(/\s+/g, " "),
    ]),
  );

/** Fail rather than diff two maps that are empty for the same reason. */
function floored(map, what) {
  if (map.size >= MIN_MODELS) return map;
  console.error(
    `\ncheck-gateway-models: parsed ${map.size} model(s) from ${what}, ` +
      `below the floor of ${MIN_MODELS}.\n\n` +
      "Both sides go through the same parser, so a parser that stopped matching\n" +
      "empties both and prints `catalog current — 0 advertised, 0 usable ✓`.\n" +
      "Check the entry regex against the file's current formatting.\n",
  );
  process.exit(1);
}

const before = floored(entries(committed), "the committed catalog");
const after = floored(entries(fresh), "the freshly generated catalog");

const changes = [];
for (const [id, info] of after) {
  if (!before.has(id)) changes.push(`  + ${id} ${info}`);
  else if (before.get(id) !== info) {
    changes.push(`  ~ ${id}\n      was ${before.get(id)}\n      now ${info}`);
  }
}
for (const id of before.keys()) if (!after.has(id)) changes.push(`  - ${id}`);

if (changes.length === 0) {
  const usable = [...before.values()].filter((i) => /live: true/.test(i)).length;
  console.log(
    `check-gateway-models: catalog current — ${before.size} advertised, ${usable} usable. ✓`,
  );
  process.exit(0);
}
console.log(changes.join("\n"));

console.error(
  "\ncheck-gateway-models: the catalog no longer matches the gateway.\n" +
    "Regenerate: node scripts/gen-gateway-models.mjs --write\n" +
    "A model that has gone away reaches users as a retried 500, not a clear error.",
);
process.exit(1);
