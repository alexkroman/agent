#!/usr/bin/env node

/**
 * Generate the docs site's provider table from the SDK's provider catalog.
 *
 * ## The drift this removes
 *
 * `docs/src/content/docs/more/voices-and-models.md` tells an author which
 * factory reads which key. It was a hand-kept copy of facts that live in the
 * SDK — each vendor's `defineProvider({ kind, stage, envVar, factory, subpath })`
 * — and it drifted the way hand-kept copies do: a provider's factory, registry
 * and tests all landed in one change set while the table went on not listing
 * it. Now the rows are rendered from `PROVIDER_CATALOG`
 * (`packages/aai/src/sdk/providers/catalog.ts`) between two markers, and
 * `--check` fails when the committed table is not what the catalog renders.
 *
 * One row per credential variable, in catalog order (STT, TTS, LLM, S2S), so
 * a key several factories share — AssemblyAI's, or OpenAI's for `llm()` and
 * `openAIS2s` — is one line naming all of them. A credential-free provider and
 * an `/experimental` one are left out: the table answers "which key do I set",
 * and the experimental subpath is undocumented by design.
 *
 * The catalog is TypeScript; Node strips its types natively, and the modules
 * it reaches import nothing but each other.
 *
 *   node scripts/sync-provider-table.mjs           # rewrite the table
 *   node scripts/sync-provider-table.mjs --check   # fail if it is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseScriptArgs } from "./_args.mjs";
import { repoRoot } from "./_fs.mjs";

const ROOT = repoRoot(import.meta.url).replace(/\/$/, "");
const CATALOG = join(ROOT, "packages/aai/src/sdk/providers/catalog.ts");
const DOC_PATH = "docs/src/content/docs/more/voices-and-models.md";
const DOC = join(ROOT, DOC_PATH);
const START =
  "<!-- provider-table:start (generated: pnpm sync:provider-table) -->";
const END = "<!-- provider-table:end -->";

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: { check: { type: "boolean" } },
});
const CHECK = FLAGS.check === true;

/** @type {{ PROVIDER_CATALOG: readonly { envVar: string, factory: string, subpath: string }[] }} */
const { PROVIDER_CATALOG } = await import(pathToFileURL(CATALOG).href);

/** Group the listed definitions by credential variable, first appearance first. */
function rows() {
  /** @type {Map<string, { factories: string[], subpaths: string[] }>} */
  const byKey = new Map();
  for (const def of PROVIDER_CATALOG) {
    if (def.envVar === "" || def.subpath === "experimental") continue;
    const row = byKey.get(def.envVar) ?? { factories: [], subpaths: [] };
    byKey.set(def.envVar, row);
    if (!row.factories.includes(def.factory)) row.factories.push(def.factory);
    if (!row.subpaths.includes(def.subpath)) row.subpaths.push(def.subpath);
  }
  return [...byKey].map(([envVar, row]) => [
    row.factories.map((f) => `\`${f}\``).join(", "),
    row.subpaths.length === 1
      ? `\`@alexkroman1/aai/${row.subpaths[0]}\``
      : row.subpaths.map((s) => `\`/${s}\``).join(", "),
    `\`${envVar}\``,
  ]);
}

/** A Markdown table padded the way Prettier pads one, so `check:prettier` agrees. */
function table(header, body) {
  const all = [header, ...body];
  const widths = header.map((_, i) => Math.max(3, ...all.map((r) => r[i].length)));
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

const rendered = table(["Factory", "Import from", "Key it reads"], rows());
const doc = readFileSync(DOC, "utf8");
const start = doc.indexOf(START);
const end = doc.indexOf(END);
if (start === -1 || end === -1 || end < start) {
  console.error(`sync-provider-table: ${DOC_PATH} has no "${START}" … "${END}" block.`);
  process.exit(1);
}
const expected = `${doc.slice(0, start + START.length)}\n\n${rendered}\n\n${doc.slice(end)}`;

if (!CHECK) {
  if (expected !== doc) writeFileSync(DOC, expected);
  console.log(
    `sync-provider-table: ${DOC_PATH} ${expected === doc ? "already current" : "rewritten"}.`,
  );
  process.exit(0);
}

if (expected === doc) {
  console.log(`sync-provider-table: ${DOC_PATH} matches the provider catalog. ✓`);
  process.exit(0);
}

console.error(
  `\nsync-provider-table: the provider table in ${DOC_PATH} is stale.\n\n` +
    "It is generated from PROVIDER_CATALOG (packages/aai/src/sdk/providers/catalog.ts),\n" +
    "the one record per vendor its factory, runtime registry and credential\n" +
    "preflight are derived from too — so a stale table is a provider an author\n" +
    "cannot find, or a key the docs name and the runtime does not read.\n\n" +
    "Run `pnpm sync:provider-table` and commit the result.\n",
);
process.exit(1);
