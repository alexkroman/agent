#!/usr/bin/env node

/**
 * Read back what the ratchets have been writing down.
 *
 * ## Why this exists
 *
 * Every gate in `.agents/ratchets.md` that cannot reach zero today records a
 * budget — `escape-hatch-baseline.json`, `guard-invariants-baseline.json`, the
 * coverage and module-test allowlists, the duplication baseline — and the epoch
 * system records something richer: a written reason for every break
 * (`contracts.json`'s `dropped`), and an epoch NUMBER per capability that is, by
 * construction, a count of breaking changes since the reset. None of it was ever
 * read again. A baseline is consulted only when a branch trips it, so the
 * ledger is a to-do list nobody opens.
 *
 * The most useful number here is the one nothing else prints: **which
 * capabilities keep bumping.** `aai:agent@14` with seven written drop reasons is
 * not fourteen unlucky pull requests; it is a design that has not settled, and
 * the reasons say where. The same goes for a file that sits in four ledgers at
 * once — that file is the root cause, and each ledger is only one symptom of it.
 *
 * ## What it reads
 *
 * - every `packages/<pkg>/src/contracts/contracts.json` and its `epochs/` tree;
 * - `scripts/guest-contract.json` (see `check-guest-contract.mjs`);
 * - every `scripts/*-baseline.json`, `*-allowlist.json` and `*-denylist.json`,
 *   plus each contract package's `internal-surface.json` and
 *   `unowned-surface.json`, DISCOVERED by name rather than listed here — a new
 *   ratchet joins the report by existing, and a hand-kept list of them is
 *   exactly the kind that goes stale in this repo;
 * - git history for epoch churn over a window, when the clone has it. A shallow
 *   clone says so rather than printing zeros that read as "stable".
 *
 * A REPORT, not a gate: it exits 0 whatever it finds. Nothing here has a right
 * answer to enforce — it is the input to deciding what to fix next.
 *
 * Usage:
 *
 *   pnpm debt:report                 # markdown to stdout
 *   pnpm debt:report --json          # the same data, for a dashboard
 *   pnpm debt:report --top 20        # rows per section (default 10)
 *   pnpm debt:report --since 180     # churn window in days (default 90)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseScriptArgs } from "./_args.mjs";
import { repoRoot } from "./_fs.mjs";
import { git } from "./_ratchet.mjs";

const ROOT = repoRoot(import.meta.url).replace(/\/$/, "");

const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: {
    json: { type: "boolean" },
    top: { type: "string" },
    since: { type: "string" },
  },
});
const TOP = Number(FLAGS.top ?? 10);
const SINCE_DAYS = Number(FLAGS.since ?? 90);
if (!Number.isInteger(TOP) || TOP < 1 || !Number.isInteger(SINCE_DAYS) || SINCE_DAYS < 1) {
  console.error("debt-report: --top and --since take positive integers.");
  process.exit(2);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const isMeta = (key) => key.startsWith("_") || key === "comment" || key === "total";
const clip = (text, n = 140) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// ---------------------------------------------------------------------------
// Epoch churn.
// ---------------------------------------------------------------------------

const packages = readdirSync(join(ROOT, "packages"))
  .map((key) => ({ key, dir: join(ROOT, "packages", key, "src/contracts") }))
  .filter(({ dir }) => existsSync(join(dir, "contracts.json")));

const shallow = git(["rev-parse", "--is-shallow-repository"]).trim() === "true";

/** Commits touching one capability's epoch directory inside the window. */
function commitsTouching(relDir) {
  if (shallow) return null;
  const out = git(["log", `--since=${SINCE_DAYS}.days`, "--format=%H", "--", relDir], {
    allowNoMatch: true,
  });
  return out.split("\n").filter(Boolean).length;
}

const capabilities = [];
for (const pkg of packages) {
  const table = readJson(join(pkg.dir, "contracts.json"));
  for (const [capability, entry] of Object.entries(table)) {
    const epochDir = join(pkg.dir, "epochs", capability);
    const currentPath = join(epochDir, `v${entry.current}.json`);
    const current = existsSync(currentPath) ? readJson(currentPath) : {};
    const dropped = Object.entries(entry.dropped ?? {}).map(([epoch, reason]) => ({
      epoch: Number(epoch),
      reason,
    }));
    capabilities.push({
      id: `${pkg.key}:${capability}`,
      epoch: entry.current,
      supported: entry.supported?.length ?? 0,
      drops: dropped.length,
      revisions: current.revisions?.length ?? 0,
      exports: current.exports?.length ?? 0,
      commits: commitsTouching(join("packages", pkg.key, "src/contracts/epochs", capability)),
      latestDrop: dropped.sort((a, b) => b.epoch - a.epoch)[0] ?? null,
    });
  }
}
// Churn first: epoch number (breaks since the reset), then revisions, then name.
capabilities.sort(
  (a, b) => b.epoch - a.epoch || b.revisions - a.revisions || a.id.localeCompare(b.id),
);

const guestPath = join(ROOT, "scripts/guest-contract.json");
const guest = existsSync(guestPath) ? readJson(guestPath) : null;

// ---------------------------------------------------------------------------
// Debt ledgers — discovered, not listed.
// ---------------------------------------------------------------------------

const ledgerFiles = [
  ...readdirSync(join(ROOT, "scripts"))
    .filter((name) => /-(baseline|allowlist|denylist)\.json$/.test(name))
    .map((name) => join("scripts", name)),
  ...packages.flatMap(({ key, dir }) =>
    ["internal-surface.json", "unowned-surface.json"]
      .filter((name) => existsSync(join(dir, name)))
      .map((name) => join("packages", key, "src/contracts", name)),
  ),
].sort();

/**
 * One category of one ledger, normalized: how many entries, the summed count
 * when entries ARE counts, and the heaviest entries.
 *
 * Shapes seen in the tree: `{ file: count }` (most ratchets), `{ file: percent }`
 * (coverage — a non-integer value is a measurement, not a count, so it is not
 * summed), `{ subpath: [names] }`, and a bare `[names]`.
 */
function summarize(value) {
  if (Array.isArray(value)) {
    return { entries: value.length, total: value.length, unit: "names", rows: [] };
  }
  // Metadata strings and numbers are not ledgers; only a plain object is.
  if (Object.prototype.toString.call(value) !== "[object Object]") return null;
  const items = Object.entries(value);
  const numeric = items.every(([, v]) => typeof v === "number");
  if (numeric) {
    const counts = items.every(([, v]) => Number.isInteger(v));
    const rows = items
      .map(([name, v]) => ({ name, value: v }))
      .sort((a, b) => (counts ? b.value - a.value : a.value - b.value));
    return {
      entries: items.length,
      total: counts ? items.reduce((sum, [, v]) => sum + v, 0) : items.length,
      unit: counts ? "count" : "measured",
      rows,
    };
  }
  const rows = items
    .map(([name, v]) => ({ name, value: Array.isArray(v) ? v.length : 1 }))
    .sort((a, b) => b.value - a.value);
  return {
    entries: items.length,
    total: rows.reduce((sum, r) => sum + r.value, 0),
    unit: "names",
    rows,
  };
}

const ledgers = [];
for (const file of ledgerFiles) {
  const data = readJson(join(ROOT, file));
  for (const [category, value] of Object.entries(data)) {
    if (isMeta(category)) continue;
    const summary = summarize(value);
    if (summary === null) continue;
    ledgers.push({ file, category, ...summary });
  }
}

/** Files that appear in the most ledger categories: the root-cause shortlist. */
const hotspots = new Map();
for (const ledger of ledgers) {
  for (const { name } of ledger.rows) {
    if (!/\.(m?[jt]sx?|md)$/.test(name)) continue;
    const list = hotspots.get(name) ?? [];
    list.push(`${ledger.file.replace(/^.*\//, "").replace(/\.json$/, "")}:${ledger.category}`);
    hotspots.set(name, list);
  }
}
const hotspotRows = [...hotspots]
  .filter(([, list]) => list.length > 1)
  .sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b));

// ---------------------------------------------------------------------------
// Output.
// ---------------------------------------------------------------------------

if (FLAGS.json === true) {
  console.log(
    JSON.stringify(
      {
        shallow,
        sinceDays: SINCE_DAYS,
        capabilities,
        guestContract: guest && { version: guest.version, history: guest.history },
        ledgers: ledgers.map(({ rows, ...rest }) => ({ ...rest, top: rows.slice(0, TOP) })),
        hotspots: hotspotRows.map(([file, list]) => ({ file, ledgers: list })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const out = [];
out.push("# Debt report", "");
out.push(
  "What the ratchets have recorded, read back. Not a gate — the input to deciding what to fix next.",
  "",
);

out.push("## Epoch churn — which capabilities keep breaking", "");
out.push(
  "An epoch number counts breaking changes since the reset, so the top of this table is the " +
    "surface that has not settled. Revisions are compatible changes recorded under the current epoch.",
  "",
);
out.push(
  shallow
    ? "_Shallow clone: commit counts are unavailable (`git fetch --unshallow` to include them)._"
    : `_Commits: changes to the capability's epoch records in the last ${SINCE_DAYS} days._`,
  "",
);
out.push("| capability | epoch | drops recorded | supported | revisions | exports | commits |");
out.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const c of capabilities.slice(0, TOP)) {
  out.push(
    `| \`${c.id}\` | ${c.epoch} | ${c.drops} | ${c.supported} | ${c.revisions} | ${c.exports} | ${c.commits ?? "—"} |`,
  );
}
const settled = capabilities.filter((c) => c.epoch === 1 && c.revisions === 0).length;
out.push(
  "",
  `${capabilities.length} capabilities; ${settled} have never moved since the reset.`,
  "",
);

const withReasons = capabilities.filter((c) => c.latestDrop !== null).slice(0, TOP);
if (withReasons.length > 0) {
  out.push("### Latest written reason, per churning capability", "");
  for (const c of withReasons) {
    out.push(
      `- **\`${c.id}\`** (dropped epoch ${c.latestDrop.epoch}): ${clip(c.latestDrop.reason, 280)}`,
    );
  }
  out.push("");
}

if (guest !== null) {
  out.push("## Deployed-guest contract", "");
  out.push(`\`GUEST_CONTRACT_VERSION\` is **${guest.version}**. Recorded changes:`, "");
  for (const h of guest.history) {
    out.push(`- v${h.version}${h.revision > 0 ? ` r${h.revision}` : ""}: ${clip(h.reason, 240)}`);
  }
  out.push("");
}

out.push("## Ledgers — every baseline, allowlist and denylist", "");
out.push("| ledger | category | entries | total | heaviest |");
out.push("| --- | --- | ---: | ---: | --- |");
const sortedLedgers = [...ledgers].sort(
  (a, b) => b.total - a.total || a.file.localeCompare(b.file),
);
const empty = sortedLedgers.filter((l) => l.entries === 0);
for (const l of sortedLedgers.filter((x) => x.entries > 0)) {
  const heaviest = l.rows
    .slice(0, 3)
    .map((r) => `\`${r.name.replace(/^packages\//, "")}\` (${r.value})`)
    .join(", ");
  const total = l.unit === "measured" ? "—" : String(l.total);
  out.push(`| \`${l.file}\` | ${l.category} | ${l.entries} | ${total} | ${heaviest || "—"} |`);
}
out.push("");
if (empty.length > 0) {
  out.push(`At zero: ${empty.map((l) => `\`${l.file}\` ${l.category}`).join(", ")}.`, "");
}

out.push("## Hotspots — files in more than one ledger", "");
out.push(
  "Each ledger is one symptom. A file carrying several is usually one root cause worth a PR of its own.",
  "",
);
if (hotspotRows.length === 0) {
  out.push("_None._", "");
} else {
  out.push("| file | ledgers |", "| --- | --- |");
  for (const [file, list] of hotspotRows.slice(0, TOP)) {
    out.push(`| \`${file}\` | ${list.join(", ")} |`);
  }
  out.push("");
}

console.log(out.join("\n"));
