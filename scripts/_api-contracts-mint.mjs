#!/usr/bin/env node

/**
 * Writing epochs: what a moved hash MEANS (`verdict`), the `--update` that
 * records a compatible change as a REVISION, and the `--bump` a breaking one
 * still owes.
 *
 * ## Revisions (G1)
 *
 * The gate used to demand `--bump` for ANY change to a capability's hash, and
 * 61 of 73 bumps after the reset were `--retain` — nothing broke, and each
 * still cost an epoch and a hand-written frozen example. So a moved hash is
 * first put to `_api-contracts-compat.mjs`, against the rollup the CURRENT
 * epoch was minted from. Compatible, it becomes revision `r+1` of the same
 * epoch: the record's `sha256`/`exports` move, `revisions` gains an entry with
 * an automatic reason, the epoch number and its rollup do not. Only a change
 * the probe cannot prove compatible needs `--bump`.
 *
 * Every revision is checked against the epoch's ORIGINAL rollup, never the
 * previous revision, so a chain of individually-compatible steps cannot walk
 * away from what the epoch promised.
 *
 * ## One per branch (G4)
 *
 * Measured against the merge-base (`_api-contracts-base.mjs`): an epoch that
 * does not exist on `main` is rewritten in place by the next `--bump`/
 * `--update` rather than superseded, a revision made on this branch is
 * replaced rather than stacked, and a hash that returns to the base's is
 * RESTORED. A `--bump` whose hash equals a supported epoch's points `current`
 * back at it instead of minting a copy.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { baseEpoch, branchState } from "./_api-contracts-base.mjs";
import { probeCompatibility } from "./_api-contracts-compat.mjs";
import { bumpedContract, bumpTarget, revisedRecord } from "./_api-contracts-epochs.mjs";
import { HASH_RULE } from "./_api-contracts-hash.mjs";
import {
  capabilityId,
  epochPath,
  epochRecord,
  FIXTURE_PLACEHOLDER,
  fixturePath,
  latestEpoch,
  readEpoch,
  readRollup,
  recordShas,
  rel,
  rollupPath,
  writeEpoch,
  writeRollup,
  writeTable,
} from "./_api-contracts-tree.mjs";

export function scaffoldFixture(pkg, capability, version) {
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

/**
 * Every frozen-example file for one epoch — `v<N>.ts(x)` and any
 * `v<N>-*.ts(x)` beside it, because an example may be split across modules
 * (`aai:testing` epoch 20 was) and a drop has to take the whole set.
 */
export function fixtureFiles(pkg, capability, epoch) {
  const dir = dirname(fixturePath(pkg, capability, epoch));
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^v${epoch}(-[A-Za-z0-9-]+)?\\.tsx?$`);
  return readdirSync(dir)
    .filter((name) => re.test(name))
    .map((name) => join(dir, name));
}

const removeFixtures = (pkg, capability, epoch) => {
  const files = fixtureFiles(pkg, capability, epoch);
  for (const file of files) rmSync(file);
  return files;
};

/** The merge-base's record of epoch `v`, if it is comparable with this rule. */
function mainRecord(pkg, capability, v) {
  const record = baseEpoch(epochPath(pkg, capability, v));
  return record !== undefined && record.rule === HASH_RULE ? record : undefined;
}

/** Probe `generated` against the rollup epoch `v` was minted from. */
function probeAgainst(pkg, capability, v, generated) {
  const oldBody = readRollup(pkg, capability, v);
  if (oldBody === undefined) {
    return {
      kind: "unproven",
      why: `${rel(rollupPath(pkg, capability, v))} is missing, so there is nothing to prove compatibility against`,
    };
  }
  const probe = probeCompatibility({ oldBody, newBody: generated.body, dir: pkg.dir });
  return probe.compatible
    ? { kind: "revision", epoch: v, added: probe.added }
    : { kind: "break", epoch: v, problems: probe.problems };
}

/**
 * What one capability's moved hash means, without writing anything.
 *
 * - `restore`: the hash is main's again — put main's record back.
 * - `unmint`: the current epoch was minted on this branch, and the change is
 *   compatible with main's epoch after all — discard it, revise main's.
 * - `refresh`: minted on this branch and still not compatible with main's —
 *   rewrite it in place (still one epoch for the branch).
 * - `revision`: compatible with the current epoch's rollup.
 * - `break` / `unproven`: a human classifies it with `--bump`.
 */
export function verdict(pkg, capability, contract, generated) {
  const epoch = contract.current;
  const state = branchState(pkg, capability);
  if (!state.epochOnMain(epoch)) {
    if (state.base === null) return { kind: "refresh" };
    const main = state.base.current;
    if (recordShas(readEpoch(pkg, capability, main)).has(generated.sha256)) {
      return { kind: "unmint", restoreOnly: true, epoch: main };
    }
    const probe = probeAgainst(pkg, capability, main, generated);
    return probe.kind === "revision"
      ? { ...probe, kind: "unmint", restoreOnly: false }
      : { kind: "refresh" };
  }
  const onMain = mainRecord(pkg, capability, epoch);
  if (onMain !== undefined && onMain.sha256 === generated.sha256) {
    return { kind: "restore", record: onMain };
  }
  return probeAgainst(pkg, capability, epoch, generated);
}

/**
 * Record `generated` as a revision of epoch `epoch`.
 *
 * The revision number is counted from the record ON MAIN, so a second
 * `--update` on one branch replaces this branch's revision instead of adding
 * another; without a base, from the working tree.
 */
function writeRevision(pkg, capability, epoch, generated, added) {
  const committed = readEpoch(pkg, capability, epoch);
  const onMain = mainRecord(pkg, capability, epoch);
  // The base's record is the one to count from — unless this branch re-pinned
  // the epoch, in which case the base's record describes another rollup.
  const from = onMain !== undefined && onMain.rollup === committed.rollup ? onMain : committed;
  const record = revisedRecord(from, generated, added);
  writeEpoch(pkg, capability, epoch, record);
  return { revision: record.revision, reason: record.revisions.at(-1).reason };
}

/** Mint (or re-mint in place) epoch `version` from `generated`. */
function mintRecord(pkg, capability, version, generated) {
  writeEpoch(pkg, capability, version, epochRecord(capability, version, generated));
  writeRollup(pkg, capability, version, generated.body);
}

/**
 * Put this branch's epochs for one capability back to the merge-base's: every
 * epoch minted here is deleted, main's current record is restored if this
 * branch revised it, and main's contract entry is returned — or `undefined`
 * when nothing was minted here.
 */
function discardBranchEpochs(pkg, capability, contract) {
  const state = branchState(pkg, capability);
  if (state.base === null || state.epochOnMain(latestEpoch(contract))) return;
  for (let v = state.baseLatest + 1; v <= latestEpoch(contract); v += 1) {
    rmSync(epochPath(pkg, capability, v), { force: true });
    rmSync(rollupPath(pkg, capability, v), { force: true });
    removeFixtures(pkg, capability, v);
  }
  const main = mainRecord(pkg, capability, state.base.current);
  if (main !== undefined) writeEpoch(pkg, capability, state.base.current, main);
  return state.base;
}

/** A capability whose committed record is current AND pinned needs no update. */
function isRecorded(pkg, capability, contract, generated) {
  const record = readEpoch(pkg, capability, contract.current);
  return (
    record.sha256 === generated.sha256 &&
    record.rule === HASH_RULE &&
    readRollup(pkg, capability, contract.current) !== undefined
  );
}

/**
 * Write one verdict that needs no human decision. Returns what was done, a
 * replacement contract entry when the table moves, or `unresolved`.
 */
function applyVerdict(pkg, capability, contract, generated, outcome) {
  const at = `${capabilityId(pkg, capability)}@${contract.current}`;
  switch (outcome.kind) {
    case "restore":
      writeEpoch(pkg, capability, contract.current, outcome.record);
      return { line: `${at}: restored to the merge-base's record` };
    case "unmint": {
      const restored = discardBranchEpochs(pkg, capability, contract);
      // Main's current epoch is current again and owes no example; one this
      // branch scaffolded for it evidenced a promise withdrawn with the epoch.
      removeFixtures(pkg, capability, outcome.epoch);
      const note = outcome.restoreOnly
        ? "matches main again"
        : `revision ${writeRevision(pkg, capability, outcome.epoch, generated, outcome.added).revision}`;
      return {
        contract: restored,
        line: `${at}: minted on this branch and discarded — epoch ${outcome.epoch} ${note}`,
      };
    }
    case "refresh":
      mintRecord(pkg, capability, contract.current, generated);
      return { line: `${at}: minted on this branch, rewritten in place` };
    case "revision": {
      const done = writeRevision(pkg, capability, contract.current, generated, outcome.added);
      return { line: `${at}: revision ${done.revision} — ${done.reason}` };
    }
    default: {
      const detail = outcome.kind === "break" ? outcome.problems.join("\n    ") : outcome.why;
      return { unresolved: `${at}: not provably compatible with its epoch:\n    ${detail}` };
    }
  }
}

/**
 * `--update`: apply every stale capability's verdict that needs no human
 * decision, writing the table when an epoch is un-minted. Returns what still
 * needs one, for the caller to fail on.
 */
export function applyUpdate(pkg, table, reports, blockersOf) {
  const lines = [];
  const unresolved = [];
  let tableChanged = false;
  for (const [capability, contract] of Object.entries(table)) {
    const generated = reports.get(capability);
    if (generated === undefined || isRecorded(pkg, capability, contract, generated)) continue;
    const blockers = blockersOf(capability);
    if (blockers.length > 0) {
      unresolved.push(
        `${capabilityId(pkg, capability)}: reaches ownerless ${blockers.join(", ")} — run the ` +
          "check for the remedy.",
      );
      continue;
    }
    const outcome = verdict(pkg, capability, contract, generated);
    const done = applyVerdict(pkg, capability, contract, generated, outcome);
    if (done.line !== undefined) lines.push(done.line);
    if (done.unresolved !== undefined) unresolved.push(done.unresolved);
    if (done.contract !== undefined) {
      table[capability] = done.contract;
      tableChanged = true;
    }
  }
  if (tableChanged) writeTable(pkg, table);
  return { lines, unresolved };
}

/**
 * The epoch a `--bump` lands on, and the new contract entry: this branch's
 * epochs discarded first (G4), then back onto a supported epoch whose hash the
 * surface returned to, else one new epoch past the latest.
 *
 * @returns {{ contract: object, target: number, previous: number, pointedBack: boolean, restored: boolean }}
 */
export function planBump(pkg, capability, contract, generated, { retain, reason }) {
  const from = discardBranchEpochs(pkg, capability, contract) ?? contract;
  const previous = from.current;
  if (recordShas(readEpoch(pkg, capability, previous)).has(generated.sha256)) {
    removeFixtures(pkg, capability, previous);
    return { contract: from, target: previous, previous, pointedBack: false, restored: true };
  }
  const shasOf = (v) => recordShas(readEpoch(pkg, capability, v));
  const { target, pointedBack } = bumpTarget(from, shasOf, generated.sha256);
  const next = bumpedContract(from, { target, retain, reason });
  if (!pointedBack) {
    mintRecord(pkg, capability, target, generated);
  } else {
    // Pointed back: the target's frozen example proved an epoch that is now
    // CURRENT, which owes none, and its rollup is the shape it returned to.
    removeFixtures(pkg, capability, target);
    if (readRollup(pkg, capability, target) === undefined) {
      writeRollup(pkg, capability, target, generated.body);
    }
  }
  if (retain) scaffoldFixture(pkg, capability, previous);
  else removeFixtures(pkg, capability, previous);
  return { contract: next, target, previous, pointedBack, restored: false };
}
