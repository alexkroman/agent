#!/usr/bin/env node

/**
 * Versioned contracts over the AUTHORING surface of `@alexkroman1/aai`.
 *
 * ## The gap this closes
 *
 * `api-report.mjs` turns a signature change into a diff, which is most of the
 * battle — but it answers "did anything move", and the question a reviewer
 * actually has to answer is "is this breaking, and for whom". That decision is
 * the changeset bump type, and this repo's own guide describes how it is made:
 * a judgement from memory, where a `patch` that was really a `major` is
 * discovered by the consumer whose build breaks.
 *
 * So the report is not the artifact here. Each CAPABILITY — a named slice of
 * the authoring API, declared by a file under `contracts/entrypoints/` — gets
 * its own report, and what is committed is that report's hash plus its export
 * list, at `contracts/epochs/<capability>/v<N>.json`. When a capability's shape
 * moves, the hash stops matching and the change cannot be committed without
 * being CLASSIFIED:
 *
 *   * `--bump <capability> --retain` keeps the previous epoch supported, which
 *     obliges a frozen authoring example under `contracts/compatibility/` that
 *     must still compile against current source. That is a test of backward
 *     compatibility rather than a claim about it.
 *   * `--bump <capability> --drop "<reason>"` records, in the tree, that the
 *     previous epoch no longer works and why.
 *
 * Old epoch metadata is immutable and retained, so "when did this break, and
 * what did we say about it" is answerable from the tree rather than from a
 * changelog nobody wrote.
 *
 * ## Capabilities, not entry points
 *
 * The twenty API reports cover every published subpath, which is right for
 * review and wrong for this. `@alexkroman1/aai` exports 174 symbols from its
 * root, 71 of them tagged `@internal` — tuning constants like
 * `PLAYBACK_CONCEAL_FLOOR` and `MIC_SILENCE_PROBE_MS` sitting in an agent
 * author's autocomplete on the same barrel as `agent()` and `tool()`. Versioning
 * that as one unit would bump the authoring contract every time a playback
 * constant moved.
 *
 * A capability names the surface instead: `agent`, `tool`, `state`, `workflow`,
 * `defaults`, `utils`, `testing`, `builtins`, and one per provider stage. The
 * gate then asserts the naming is EXHAUSTIVE — every `@public` export of the
 * authoring subpaths belongs to exactly one capability — with the
 * `@internal`-tagged names as an explicit, committed exemption that may shrink
 * and may never grow (`contracts/internal-surface.json`). The tag documented
 * that problem; this counts it.
 *
 * ## Usage
 *
 *   node scripts/api-contracts.mjs                          # the gate
 *   node scripts/api-contracts.mjs --bump tool --retain
 *   node scripts/api-contracts.mjs --bump tool --drop "…"
 *   node scripts/api-contracts.mjs --update-internal         # lower the ratchet
 *   node scripts/api-contracts.mjs --init                    # bootstrap epoch 1
 *
 * It reads `dist/*.d.ts` and the committed reports, so it runs after the build
 * and after `check:api-report`.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  authoringSurface,
  capabilities,
  FIXTURE_PLACEHOLDER,
  fixturePath,
  generateCapabilityReports,
  parseEntrypoint,
  readEpoch,
  readTable,
  rel,
  TABLE_PATH,
  writeEpoch,
  writeInternalSurface,
  writeTable,
} from "./_api-contracts.mjs";
import { classify, internalSurfaceSnapshot, runChecks } from "./_api-contracts-checks.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : (argv[index + 1] ?? "");
};
const has = (name) => argv.includes(name);

const CONTRACT_KIND = "aai-authoring-capability-contract";

// ---------------------------------------------------------------------------
// Mutating modes
// ---------------------------------------------------------------------------

const epochRecord = (capability, epoch, generated) => ({
  kind: CONTRACT_KIND,
  capability,
  epoch,
  sha256: generated.sha256,
  exports: generated.exports,
});

function scaffoldFixture(capability, version) {
  const path = fixturePath(capability, version);
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    "// Copyright 2025 the AAI authors. MIT license.\n" +
      "/**\n" +
      ` * Frozen authoring example: \`${capability}\` epoch ${version}.\n` +
      " *\n" +
      ` * Replace this scaffold with a representative example of how the ${capability}\n` +
      ` * capability was authored at epoch ${version}. It must keep compiling against\n` +
      " * current source for as long as that epoch is advertised as supported —\n" +
      ` * ${FIXTURE_PLACEHOLDER}\n` +
      " */\n\nexport {};\n",
  );
  return path;
}

function init() {
  const reports = generateCapabilityReports();
  const table = existsSync(TABLE_PATH) ? readTable() : {};
  let created = 0;
  for (const [capability, generated] of reports) {
    if (table[capability] !== undefined) continue;
    table[capability] = { current: 1, supported: [1], dropped: {} };
    writeEpoch(capability, 1, epochRecord(capability, 1, generated));
    scaffoldFixture(capability, 1);
    created += 1;
  }
  writeTable(Object.fromEntries(Object.entries(table).sort()));
  writeInternalSurface(internalSurfaceSnapshot(authoringSurface().internalNames));
  console.log(`api-contracts: bootstrapped ${created} capability contract(s) at epoch 1.`);
}

function bump(capability) {
  const table = readTable();
  const contract = table[capability];
  if (contract === undefined) {
    console.error(`api-contracts: unknown capability "${capability}".`);
    process.exit(1);
  }
  const retain = has("--retain");
  const reason = flag("--drop");
  if (retain === (reason !== undefined)) {
    console.error(
      'api-contracts: pass exactly one of `--retain` or `--drop "<reason>"`.\n' +
        "  The choice is the classification, and it is the only thing this tool " +
        "cannot decide for you.",
    );
    process.exit(1);
  }
  if (!retain && reason.trim() === "") {
    console.error("api-contracts: `--drop` needs a reason — it is what a future reader reads.");
    process.exit(1);
  }

  const generated = generateCapabilityReports([capability]).get(capability);
  const committed = readEpoch(capability, contract.current);
  if (committed.sha256 === generated.sha256) {
    console.error(
      `api-contracts: "${capability}" still matches epoch ${contract.current}; nothing to bump.`,
    );
    process.exit(1);
  }

  const next = contract.current + 1;
  table[capability] = {
    current: next,
    supported: retain
      ? [...contract.supported, next]
      : [...contract.supported.filter((version) => version !== contract.current), next],
    dropped: retain ? contract.dropped : { ...contract.dropped, [contract.current]: reason },
  };
  writeEpoch(capability, next, epochRecord(capability, next, generated));
  writeTable(table);
  const fixture = scaffoldFixture(capability, next);

  // A dropped epoch's example does not compile — that is what "dropped" MEANS —
  // and it sits under the package tsconfig, so leaving it behind turns the
  // classification into a red `pnpm typecheck`. The epoch metadata is immutable
  // and keeps the record; the example was only ever the evidence for a promise
  // that is now withdrawn.
  const retired = fixturePath(capability, contract.current);
  if (!retain && existsSync(retired)) rmSync(retired);

  const { added, removed, bump: suggested } = classify(committed.exports ?? [], generated.exports);
  console.log(
    `api-contracts: "${capability}" is now epoch ${next}.\n` +
      (removed.length > 0 ? `  removed: ${removed.join(", ")}\n` : "") +
      (added.length > 0 ? `  added:   ${added.join(", ")}\n` : "") +
      `  epoch ${contract.current}: ${retain ? "RETAINED as supported" : `DROPPED — ${reason}`}\n` +
      `  Write the epoch ${next} example: ${rel(fixture)}\n` +
      (retain
        ? `  Epoch ${contract.current}'s example must keep compiling: ${rel(fixturePath(capability, contract.current))}\n`
        : `  Removed epoch ${contract.current}'s example (${rel(retired)}) — a dropped epoch has no promise left to evidence.\n`) +
      `  Suggested changeset bump: ${retain ? suggested : "major"}.`,
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (has("--init")) {
  init();
  process.exit(0);
}

if (has("--update-internal")) {
  writeInternalSurface(internalSurfaceSnapshot(authoringSurface().internalNames));
  console.log("api-contracts: internal-surface baseline lowered to match the tree.");
  process.exit(0);
}

const bumpTarget = flag("--bump");
if (bumpTarget !== undefined) {
  bump(bumpTarget);
  process.exit(0);
}

const present = capabilities();
if (present.length === 0) {
  console.error(
    "api-contracts: no capability entry points found — is contracts/entrypoints/ empty?",
  );
  process.exit(1);
}

const table = readTable();
const { issues, warnings } = runChecks({
  table,
  present,
  entries: present.map((capability) => parseEntrypoint(capability)),
  // A thunk: extraction costs a whole `dist` parse, and `runChecks` skips it
  // entirely when the table it would be compared against is malformed.
  reports: () => generateCapabilityReports(present),
});

for (const warning of warnings) {
  console.warn(`\napi-contracts: ${warning.replaceAll("\n", "\n  ")}\n`);
}

if (issues.length > 0) {
  console.error(`\napi-contracts: ${issues.length} issue(s):\n`);
  for (const issue of issues) console.error(`  ${issue.replaceAll("\n", "\n  ")}\n`);
  process.exit(1);
}

const epochs = Object.entries(table)
  .map(([capability, { current }]) => `${capability}@${current}`)
  .join(" ");
console.log(`api-contracts: ${present.length} capability contract(s) up to date. ✓\n  ${epochs}`);
