#!/usr/bin/env node

/**
 * Versioned contracts over the AUTHORING surface of the published packages —
 * `@alexkroman1/aai`, `@alexkroman1/aai-ui` and `@alexkroman1/aai-runtime`.
 *
 * ## The gap this closes
 *
 * `api-report.mjs` turns a signature change into a diff, which answers "did
 * anything move". The question a reviewer has to answer is "is this breaking,
 * and for whom" — the changeset bump type — and that used to be a judgement
 * from memory, found wrong by the consumer whose build breaks.
 *
 * So each CAPABILITY — a named slice of one package's authoring API, declared
 * by a file under `<package>/src/contracts/entrypoints/` — gets its own report,
 * and what is committed is that report's hash, export list and rollup, at
 * `<package>/src/contracts/epochs/<capability>/v<N>.json` + `v<N>.rollup.txt`.
 * When a capability's hash moves, the check FAILS (the record is stale, like a
 * stale API report) and says which command settles it:
 *
 *   * `--update` when the change is PROVABLY backward compatible
 *     (`_api-contracts-compat.mjs` compiles the epoch's rollup against the new
 *     one): it becomes a REVISION of the same epoch — no new epoch, no example.
 *   * `--bump <capability> --drop "<reason>"` when it is not: the previous
 *     epoch no longer works, and the tree records why.
 *   * `--bump <capability> --retain` when the probe could not prove it but the
 *     author can: the previous epoch stays supported and owes a frozen example
 *     under `src/contracts/compatibility/` that must keep compiling.
 *
 * At most one epoch and one revision per capability per BRANCH, measured
 * against the merge-base (`_api-contracts-base.mjs`); every hashed declaration
 * has exactly one owner (`_api-contracts-ownership.mjs`). Old epoch metadata
 * is retained, so "when did this break, and what did we say" is in the tree.
 *
 * ## Capabilities, not entry points, and QUALIFIED
 *
 * The API reports cover every published subpath; a capability names the
 * surface an author writes against instead, and the gate asserts the naming is
 * EXHAUSTIVE — every `@public` export of every authoring subpath belongs to
 * exactly one capability of its package, with `@internal` names as a committed
 * shrink-only exemption (`contracts/internal-surface.json`). Names are unique
 * only within a package (`workflow` is three contracts), so anything a human
 * types is `aai-ui:workflow`; a bare name works when unambiguous.
 *
 * ## Usage
 *
 *   node scripts/api-contracts.mjs                              # the gate
 *   node scripts/api-contracts.mjs --update                     # record compatible changes
 *   node scripts/api-contracts.mjs --bump aai:tool --drop "…"   # classify a break
 *   node scripts/api-contracts.mjs --bump aai-ui:forms --retain
 *   node scripts/api-contracts.mjs --retire aai:step --epoch 3 --drop "…"
 *   node scripts/api-contracts.mjs --update-internal            # lower the ratchets
 *   node scripts/api-contracts.mjs --init                       # bootstrap epoch 1
 *   node scripts/api-contracts.mjs --rehash --because "…"       # the hash RULE moved
 *   … --base <ref|none>                                         # measure against <ref>
 *
 * It reads `dist/*.d.ts` and the committed reports, so it runs after the build
 * and after `check:api-report`.
 */

import { existsSync, rmSync } from "node:fs";
import { authoringSurface, generateCapabilityReports, parseEntrypoint } from "./_api-contracts.mjs";
import { hasBase, useBase } from "./_api-contracts-base.mjs";
import { classify, internalSurfaceSnapshot, runChecks } from "./_api-contracts-checks.mjs";
import { applyUpdate, fixtureFiles, planBump, verdict } from "./_api-contracts-mint.mjs";
import {
  lowerOwnershipBaseline,
  ownershipBlockers,
  ownershipFindings,
  seedOwnershipBaseline,
} from "./_api-contracts-ownership.mjs";
import { rehash } from "./_api-contracts-rehash.mjs";
import {
  capabilities,
  capabilityId,
  contractPackages,
  epochRecord,
  fixturePath,
  readEpoch,
  readTable,
  recordShas,
  rel,
  writeEpoch,
  writeInternalSurface,
  writeRollup,
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
    rehash: { type: "boolean" },
    update: { type: "boolean" },
    base: { type: "string" },
    because: { type: "string" },
  },
});

if (FLAGS.base !== undefined) useBase(FLAGS.base);

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

function init() {
  let created = 0;
  for (const pkg of packages) {
    const reports = generateCapabilityReports(pkg);
    const table = existsSync(pkg.tablePath) ? readTable(pkg) : {};
    for (const [capability, generated] of reports) {
      if (table[capability] !== undefined) continue;
      table[capability] = { current: 1, supported: [1], dropped: {} };
      writeEpoch(pkg, capability, 1, epochRecord(capability, 1, generated));
      writeRollup(pkg, capability, 1, generated.body);
      created += 1;
    }
    writeTable(pkg, Object.fromEntries(Object.entries(table).sort()));
    writeInternalSurface(pkg, internalSurfaceSnapshot(authoringSurface(pkg).internalNames));
    seedOwnershipBaseline(pkg, ownershipFindings(pkg, reports));
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
  const files = fixtureFiles(pkg, capability, epoch);
  const retired = files.join(", ") || fixturePath(pkg, capability, epoch);
  const had = files.length > 0;
  for (const f of files) rmSync(f);
  console.log(
    `api-contracts: "${id}" epoch ${epoch}: DROPPED — ${reason}\n` +
      `  still supported: ${table[capability].supported.join(", ") || "(none but current)"}\n` +
      (had ? `  removed its frozen example ${rel(retired)}.\n` : "  it had no frozen example.\n"),
  );
}

/**
 * `--bump`: classify a change `--update` could not prove compatible.
 *
 * `planBump` (`_api-contracts-mint.mjs`) decides WHERE it lands: at most one
 * new epoch per branch, measured against the merge-base, and back onto a
 * supported epoch whose hash the surface returned to rather than a copy of it.
 */
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

  const reports = generateCapabilityReports(pkg);
  const generated = reports.get(capability);
  const blockers = ownershipBlockers(pkg, ownershipFindings(pkg, reports), capability);
  if (blockers.length > 0) {
    console.error(
      `api-contracts: refusing to bump "${id}": its surface reaches ownerless ${blockers.join(", ")}.\n` +
        "  An epoch minted over a type nobody owns is re-minted the moment somebody exports it " +
        "(that is how aai-runtime:eval went v4 then v5). Give it an owner first — run the check " +
        "for the remedy.",
    );
    process.exit(1);
  }
  const committed = readEpoch(pkg, capability, contract.current);
  if (recordShas(committed).has(generated.sha256)) {
    console.error(
      `api-contracts: "${id}" still matches epoch ${contract.current}; nothing to bump.`,
    );
    process.exit(1);
  }
  const outcome = verdict(pkg, capability, contract, generated);
  if (["revision", "restore", "unmint"].includes(outcome.kind)) {
    console.error(
      `api-contracts: "${id}"'s change is backward compatible with epoch ${contract.current} — ` +
        "record it with `node scripts/api-contracts.mjs --update`, no bump needed.",
    );
    process.exit(1);
  }

  const plan = planBump(pkg, capability, contract, generated, { retain, reason });
  table[capability] = plan.contract;
  writeTable(pkg, table);
  if (plan.restored) {
    console.log(`api-contracts: "${id}" matches main's epoch ${plan.target} again; restored it.`);
    return;
  }
  const { added, removed, bump: suggested } = classify(committed.exports ?? [], generated.exports);
  console.log(
    `api-contracts: "${id}" is now epoch ${plan.target}` +
      (plan.pointedBack ? " (pointed BACK: the surface matches that supported epoch again)" : "") +
      ".\n" +
      (removed.length > 0 ? `  removed: ${removed.join(", ")}\n` : "") +
      (added.length > 0 ? `  added:   ${added.join(", ")}\n` : "") +
      (retain
        ? `  epoch ${plan.previous}: RETAINED as supported\n` +
          `  Write epoch ${plan.previous}'s example — it is a promise now: ` +
          `${rel(fixturePath(pkg, capability, plan.previous))}\n  Suggested changeset bump: ${suggested}.`
        : `  epoch ${plan.previous}: DROPPED — ${reason}\n  Suggested changeset bump: major.`),
  );
}

/**
 * `--update`: re-verify every stale capability and record what needs no human
 * decision — a revision, an in-place rewrite of an epoch minted on this
 * branch, or a restore to the merge-base. Exits non-zero naming whatever is
 * left for `--bump`.
 */
function update() {
  let failed = false;
  for (const pkg of packages) {
    const reports = generateCapabilityReports(pkg);
    const findings = ownershipFindings(pkg, reports);
    const { lines, unresolved } = applyUpdate(pkg, readTable(pkg), reports, (capability) =>
      ownershipBlockers(pkg, findings, capability),
    );
    for (const line of lines) console.log(`api-contracts: ${line}`);
    for (const line of unresolved) console.error(`api-contracts: ${line}`);
    if (unresolved.length > 0) failed = true;
  }
  if (failed) {
    console.error(
      '\napi-contracts: classify what is left with --bump <capability> --drop "<reason>", or ' +
        "--retain with a frozen example if you can show it still compiles.",
    );
    process.exit(1);
  }
  console.log("api-contracts: every capability is recorded.");
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
    lowerOwnershipBaseline(pkg, ownershipFindings(pkg, generateCapabilityReports(pkg)));
  }
  console.log("api-contracts: internal-surface and ownerless baselines lowered to match the tree.");
  process.exit(0);
}

if (FLAGS.update === true) {
  update();
  process.exit(0);
}

if (FLAGS.rehash === true) {
  rehash(packages, FLAGS.because);
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

if (!hasBase()) {
  // Never a checkmark over a comparison that could not be made: the tree was
  // fully checked, but "one epoch per branch" needs a merge-base.
  console.warn(
    "\napi-contracts: no merge-base with origin/main or main, so the one-epoch-per-branch " +
      "check did NOT run. Fetch main, or pass --base <ref>.\n",
  );
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
