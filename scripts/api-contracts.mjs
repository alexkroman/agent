#!/usr/bin/env node

/**
 * Versioned contracts over the AUTHORING surface of the published packages —
 * `@alexkroman1/aai` and `@alexkroman1/aai-ui`.
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
 * one package's authoring API, declared by a file under
 * `<package>/contracts/entrypoints/` — gets its own report, and what is
 * committed is that report's hash plus its export list, at
 * `<package>/contracts/epochs/<capability>/v<N>.json`. When a capability's shape
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
 * The API reports cover every published subpath, which is right for review and
 * wrong for this. `@alexkroman1/aai` exports 174 symbols from its root, 71 of
 * them tagged `@internal` — tuning constants like `PLAYBACK_CONCEAL_FLOOR` and
 * `MIC_SILENCE_PROBE_MS` sitting in an agent author's autocomplete on the same
 * barrel as `agent()` and `tool()`. Versioning that as one unit would bump the
 * authoring contract every time a playback constant moved.
 *
 * A capability names the surface instead: `agent`, `tool`, `state`, `workflow`,
 * `defaults`, `utils`, `testing`, `builtins` and one per provider stage for the
 * SDK; `client`, `page`, `session`, `hooks`, `components`, `forms`, `workflow`,
 * `theme` and `client-dir` for the browser client. The gate then asserts the
 * naming is EXHAUSTIVE — every `@public` export of every authoring subpath
 * belongs to exactly one of its package's capabilities — with the
 * `@internal`-tagged names as an explicit, committed exemption that may shrink
 * and may never grow (`contracts/internal-surface.json`). The tag documented
 * that problem; this counts it.
 *
 * ## Two packages, so a capability is QUALIFIED
 *
 * Capability names are unique within a package and not across them: `workflow`
 * is a capability of both, and they are different contracts — the SDK's
 * `workflow()` declaration and the browser's `createWorkflowApi` client. So
 * anything a human reads or types is `aai-ui:workflow`, while the epoch files
 * stay unqualified because their path already names the package.
 *
 * ## Usage
 *
 *   node scripts/api-contracts.mjs                              # the gate
 *   node scripts/api-contracts.mjs --bump aai-ui:forms --retain
 *   node scripts/api-contracts.mjs --bump aai:tool --drop "…"
 *   node scripts/api-contracts.mjs --update-internal             # lower the ratchet
 *   node scripts/api-contracts.mjs --init                        # bootstrap epoch 1
 *
 * A bare capability name works whenever it is unambiguous; `aai:tool` and
 * `aai-ui:forms` always do.
 *
 * It reads `dist/*.d.ts` and the committed reports, so it runs after the build
 * and after `check:api-report`.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { authoringSurface, generateCapabilityReports, parseEntrypoint } from "./_api-contracts.mjs";
import { classify, internalSurfaceSnapshot, runChecks } from "./_api-contracts-checks.mjs";
import {
  capabilities,
  capabilityId,
  contractPackages,
  FIXTURE_PLACEHOLDER,
  fixturePath,
  readEpoch,
  readTable,
  rel,
  writeEpoch,
  writeInternalSurface,
  writeTable,
} from "./_api-contracts-tree.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : (argv[index + 1] ?? "");
};
const has = (name) => argv.includes(name);

const CONTRACT_KIND = "aai-authoring-capability-contract";

const packages = contractPackages();
if (packages.length === 0) {
  console.error(
    "api-contracts: no package carries contracts/entrypoints/ — has the tree moved? A package " +
      "opts in by creating that directory.",
  );
  process.exit(1);
}

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

function scaffoldFixture(pkg, capability, version) {
  const path = fixturePath(pkg, capability, version);
  if (existsSync(path)) return path;
  const id = capabilityId(pkg, capability);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    "// Copyright 2025 the AAI authors. MIT license.\n" +
      "/**\n" +
      ` * Frozen authoring example: \`${id}\` epoch ${version}.\n` +
      " *\n" +
      ` * Replace this scaffold with a representative example of how the ${id}\n` +
      ` * capability was authored at epoch ${version}. It must keep compiling against\n` +
      " * current source for as long as that epoch is advertised as supported —\n" +
      ` * ${FIXTURE_PLACEHOLDER}\n` +
      " */\n\nexport {};\n",
  );
  return path;
}

function init() {
  let created = 0;
  for (const pkg of packages) {
    const reports = generateCapabilityReports(pkg);
    const table = existsSync(pkg.tablePath) ? readTable(pkg) : {};
    for (const [capability, generated] of reports) {
      if (table[capability] !== undefined) continue;
      table[capability] = { current: 1, supported: [1], dropped: {} };
      writeEpoch(pkg, capability, 1, epochRecord(capability, 1, generated));
      created += 1;
    }
    writeTable(pkg, Object.fromEntries(Object.entries(table).sort()));
    writeInternalSurface(pkg, internalSurfaceSnapshot(authoringSurface(pkg).internalNames));
  }
  console.log(`api-contracts: bootstrapped ${created} capability contract(s) at epoch 1.`);
}

/**
 * `aai-ui:forms` -> that package and capability; a bare `forms` resolves when
 * exactly one package has it.
 *
 * Ambiguity is REFUSED rather than resolved by precedence: `workflow` names two
 * real contracts, and guessing which one to bump would record a classification
 * against the wrong surface — the one failure this whole gate exists to prevent.
 */
function resolveTarget(target) {
  const [left, right] = target.includes(":") ? target.split(":", 2) : [undefined, target];
  const matches = packages
    .filter((pkg) => left === undefined || pkg.key === left)
    .filter((pkg) => capabilities(pkg).includes(right))
    .map((pkg) => ({ pkg, capability: right }));
  if (matches.length === 1) return matches[0];
  const known = packages
    .flatMap((pkg) => capabilities(pkg).map((capability) => capabilityId(pkg, capability)))
    .join(", ");
  console.error(
    matches.length === 0
      ? `api-contracts: unknown capability "${target}".\n  Known: ${known}`
      : `api-contracts: "${target}" is ambiguous — qualify it as ` +
          `${matches.map(({ pkg, capability }) => capabilityId(pkg, capability)).join(" or ")}.`,
  );
  process.exit(1);
}

function bump(target) {
  const { pkg, capability } = resolveTarget(target);
  const id = capabilityId(pkg, capability);
  const table = readTable(pkg);
  const contract = table[capability];
  if (contract === undefined) {
    console.error(`api-contracts: "${id}" has no entry in ${rel(pkg.tablePath)}.`);
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

  const generated = generateCapabilityReports(pkg, [capability]).get(capability);
  const committed = readEpoch(pkg, capability, contract.current);
  if (committed.sha256 === generated.sha256) {
    console.error(
      `api-contracts: "${id}" still matches epoch ${contract.current}; nothing to bump.`,
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
  writeEpoch(pkg, capability, next, epochRecord(capability, next, generated));
  writeTable(pkg, table);
  // The RETAINED epoch is the one that just became a promise, so it is the one
  // that owes an example. The new epoch is current and owes none until it is
  // superseded and retained in its turn.
  const fixture = retain ? scaffoldFixture(pkg, capability, contract.current) : undefined;

  // A dropped epoch's example does not compile — that is what "dropped" MEANS —
  // and it sits under the package tsconfig, so leaving it behind turns the
  // classification into a red `pnpm typecheck`. The epoch metadata is immutable
  // and keeps the record; the example was only ever the evidence for a promise
  // that is now withdrawn.
  const retired = fixturePath(pkg, capability, contract.current);
  if (!retain && existsSync(retired)) rmSync(retired);

  const { added, removed, bump: suggested } = classify(committed.exports ?? [], generated.exports);
  console.log(
    `api-contracts: "${id}" is now epoch ${next}.\n` +
      (removed.length > 0 ? `  removed: ${removed.join(", ")}\n` : "") +
      (added.length > 0 ? `  added:   ${added.join(", ")}\n` : "") +
      `  epoch ${contract.current}: ${retain ? "RETAINED as supported" : `DROPPED — ${reason}`}\n` +
      (retain
        ? `  Write epoch ${contract.current}'s example — it is a promise now: ${rel(fixture)}\n`
        : `  Epoch ${contract.current} is dropped, so it evidences nothing${existsSync(retired) ? ` (removed ${rel(retired)})` : ""}.\n`) +
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
  for (const pkg of packages) {
    writeInternalSurface(pkg, internalSurfaceSnapshot(authoringSurface(pkg).internalNames));
  }
  console.log("api-contracts: internal-surface baselines lowered to match the tree.");
  process.exit(0);
}

const bumpTarget = flag("--bump");
if (bumpTarget !== undefined) {
  bump(bumpTarget);
  process.exit(0);
}

const issues = [];
const summary = [];
let checked = 0;

for (const pkg of packages) {
  const present = capabilities(pkg);
  if (present.length === 0) {
    issues.push(`${rel(pkg.entrypointRoot)}/ holds no capability entry point.`);
    continue;
  }
  const table = readTable(pkg);
  const outcome = runChecks({
    pkg,
    table,
    present,
    entries: present.map((capability) => parseEntrypoint(pkg, capability)),
    // A thunk: extraction costs a whole `dist` parse, and `runChecks` skips it
    // entirely when the table it would be compared against is malformed.
    reports: () => generateCapabilityReports(pkg, present),
  });
  issues.push(...outcome.issues);
  checked += present.length;
  summary.push(
    `${pkg.name}: ${Object.entries(table)
      .map(([capability, { current }]) => `${capability}@${current}`)
      .join(" ")}`,
  );
  for (const warning of outcome.warnings) {
    console.warn(`\napi-contracts: ${warning.replaceAll("\n", "\n  ")}\n`);
  }
}

if (issues.length > 0) {
  console.error(`\napi-contracts: ${issues.length} issue(s):\n`);
  for (const issue of issues) console.error(`  ${issue.replaceAll("\n", "\n  ")}\n`);
  process.exit(1);
}

console.log(
  `api-contracts: ${checked} capability contract(s) across ${packages.length} package(s) up to ` +
    `date. ✓\n  ${summary.join("\n  ")}`,
);
