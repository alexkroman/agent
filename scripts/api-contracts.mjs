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
import { parseScriptArgs } from "./_args.mjs";

/**
 * Strict, because every one of these five flags decides what gets WRITTEN.
 *
 * The old reader answered `""` for a value flag in final position, so
 * `--bump` with nothing after it ran `bump("")` and `--drop` with nothing after
 * it reached the reason check as an empty string. `parseArgs` rejects both at the
 * parse, which is the same argument as the `--check` family: a classification
 * recorded against the wrong capability is the failure this gate exists to
 * prevent, and a mistyped flag is how you get one.
 */
const { values: FLAGS } = parseScriptArgs({
  script: import.meta.url,
  options: {
    bump: { type: "string" },
    drop: { type: "string" },
    retain: { type: "boolean" },
    retire: { type: "string" },
    epoch: { type: "string" },
    init: { type: "boolean" },
    "update-internal": { type: "boolean" },
  },
});

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

/**
 * Withdraw a promise about an OLDER epoch that is still advertised as supported.
 *
 * `bump` only ever touches `contract.current`, which is right for the ordinary
 * case: a surface moves, the epoch that just stopped being current is the one
 * whose status is in question. A RENAME is the case it cannot express. Removing
 * a name invalidates every supported epoch whose frozen example uses it, all at
 * once and regardless of age — `aai:step` advertised 3, 5 and 8, and dropping
 * `emit`/`report` left the examples for 3 and 5 unable to compile while the
 * table still called them supported.
 *
 * That state is the one thing this gate exists to prevent: a promise the tree
 * contradicts. It was also unreachable through the CLI, so the only way to
 * record the truth was to hand-edit the table `writeTable` owns — which is how
 * a classification ends up attributed to nobody. Hence this mode. It refuses
 * the current epoch (that is `--bump --drop`'s job) and refuses an epoch the
 * table does not advertise, because both would record a verdict about
 * something other than a live promise.
 */
function retire(target) {
  const { pkg, capability } = resolveTarget(target);
  const id = capabilityId(pkg, capability);
  const reason = FLAGS.drop;
  if (reason === undefined || reason.trim() === "") {
    console.error(
      'api-contracts: `--retire` needs `--drop "<reason>"` — it is what a future reader reads.',
    );
    process.exit(1);
  }
  const epoch = Number(FLAGS.epoch);
  if (!Number.isInteger(epoch) || epoch < 1) {
    console.error("api-contracts: `--retire` needs `--epoch <n>`, a positive integer.");
    process.exit(1);
  }
  const table = readTable(pkg);
  const contract = table[capability];
  if (contract === undefined) {
    console.error(`api-contracts: "${id}" has no contract yet — run --init.`);
    process.exit(1);
  }
  if (epoch === contract.current) {
    console.error(
      `api-contracts: epoch ${epoch} is "${id}"'s CURRENT epoch. Retiring the current ` +
        "epoch is what `--bump --drop` does, and it records the successor too.",
    );
    process.exit(1);
  }
  if (!contract.supported.includes(epoch)) {
    console.error(
      `api-contracts: "${id}" does not advertise epoch ${epoch} as supported ` +
        `(supported: ${contract.supported.join(", ")}), so there is no promise to withdraw.`,
    );
    process.exit(1);
  }
  table[capability] = {
    current: contract.current,
    supported: contract.supported.filter((version) => version !== epoch),
    dropped: { ...contract.dropped, [epoch]: reason },
  };
  writeTable(pkg, table);
  // Same argument as `bump`'s: a dropped epoch's example does not compile, and
  // it sits under the package tsconfig, so leaving it behind turns the
  // classification into a red `pnpm typecheck`. The epoch record keeps history.
  const retired = fixturePath(pkg, capability, epoch);
  const had = existsSync(retired);
  if (had) rmSync(retired);
  console.log(
    `api-contracts: "${id}" epoch ${epoch}: DROPPED — ${reason}\n` +
      `  still supported: ${table[capability].supported.join(", ") || "(none but current)"}\n` +
      (had ? `  removed its frozen example ${rel(retired)}.\n` : "  it had no frozen example.\n"),
  );
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
  const retain = FLAGS.retain === true;
  const reason = FLAGS.drop;
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
      bumpVerdict({ contract, fixture, retain, reason, retired, suggested }),
  );
}

/**
 * The classification half of what `bump` prints — extracted so `bump` itself
 * stays under the cognitive-complexity cap, which the epoch-vs-fixture
 * branching pushed it over.
 */
function bumpVerdict({ contract, fixture, retain, reason, retired, suggested }) {
  const previous = contract.current;
  if (retain) {
    return (
      `  epoch ${previous}: RETAINED as supported\n` +
      `  Write epoch ${previous}'s example — it is a promise now: ${rel(fixture)}\n` +
      `  Suggested changeset bump: ${suggested}.`
    );
  }
  const removedNote = existsSync(retired) ? ` (removed ${rel(retired)})` : "";
  return (
    `  epoch ${previous}: DROPPED — ${reason}\n` +
    `  Epoch ${previous} evidences nothing now${removedNote}.\n` +
    "  Suggested changeset bump: major."
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (FLAGS.init === true) {
  init();
  process.exit(0);
}

if (FLAGS["update-internal"] === true) {
  for (const pkg of packages) {
    writeInternalSurface(pkg, internalSurfaceSnapshot(authoringSurface(pkg).internalNames));
  }
  console.log("api-contracts: internal-surface baselines lowered to match the tree.");
  process.exit(0);
}

const retireTarget = FLAGS.retire;
if (retireTarget !== undefined) {
  retire(retireTarget);
  process.exit(0);
}

const bumpTarget = FLAGS.bump;
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
