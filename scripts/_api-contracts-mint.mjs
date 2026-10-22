#!/usr/bin/env node

/**
 * Writing epochs: what a moved hash MEANS (`verdict`), and the `--bump` /
 * `--unbump` that are now the only writers of an epoch record.
 *
 * ## A compatible change is not recorded at all
 *
 * The gate used to demand `--update` for every compatible hash move, which
 * wrote a REVISION into the record — about 90 such writes in the month after
 * 2026-09-23, against 50 epochs, each a commit-noise diff recording a decision
 * the probe had already made. Now a moved hash is put to
 * `_api-contracts-compat.mjs` against the rollup the CURRENT epoch was minted
 * from, and a compatible verdict simply PASSES: nothing is written, and the
 * record's sha is only a fast path that skips the probe when the surface has
 * not moved since the epoch was minted.
 *
 * Every probe is against the epoch's ORIGINAL rollup, never a later state, so
 * a chain of individually-compatible steps cannot walk away from what the
 * epoch promised — that is what makes skipping the record write sound.
 *
 * ## One per branch (G4)
 *
 * Measured against the merge-base (`_api-contracts-base.mjs`): an epoch that
 * does not exist on `main` is rewritten in place by the next `--bump` rather
 * than superseded, and one whose change turned out compatible with main's
 * epoch after all is discarded by `--unbump`. A `--bump` whose hash equals a
 * supported epoch's points `current` back at it instead of minting a copy.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { branchState } from "./_api-contracts-base.mjs";
import { probeCompatibility } from "./_api-contracts-compat.mjs";
import { bumpedContract, bumpTarget } from "./_api-contracts-epochs.mjs";
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

/** Probe `generated` against the rollup epoch `v` was minted from. */
function probeAgainst(pkg, capability, v, generated) {
  const oldBody = readRollup(pkg, capability, v);
  if (oldBody === undefined) {
    return {
      kind: "unproven",
      why: `${rel(rollupPath(pkg, capability, v))} is missing, so there is nothing to prove compatibility against`,
    };
  }
  const probe = probeCompatibility({
    oldBody,
    newBody: generated.body,
    dir: pkg.dir,
    foreign: generated.foreign,
  });
  if (probe.compatible) return { kind: "compatible", epoch: v, added: probe.added };
  // Every finding a one-sided `any`: nothing FAILED, the probe just cannot
  // decide those positions — which a human classifies, not a "major" guess.
  return probe.problems.every((problem) => probe.unproven.includes(problem))
    ? { kind: "unproven", why: probe.problems.join("\n    ") }
    : { kind: "break", epoch: v, problems: probe.problems };
}

/**
 * What one capability's moved hash means, without writing anything. The
 * caller has already found the sha in none of the current epoch's records.
 *
 * - `compatible`: provably compatible with the epoch it is measured against —
 *   the gate PASSES it, and nothing is written.
 * - `unmint`: the current epoch was minted on this branch, and the change is
 *   compatible with main's epoch after all — `--unbump` discards it.
 * - `refresh`: minted on this branch and compatible with neither — re-run the
 *   `--bump`, which rewrites this branch's epoch in place.
 * - `break` / `unproven`: a human classifies it with `--bump`.
 */
export function verdict(pkg, capability, contract, generated) {
  const epoch = contract.current;
  const state = branchState(pkg, capability);
  if (state.base !== null && !state.epochOnMain(epoch)) {
    const main = state.base.current;
    if (recordShas(readEpoch(pkg, capability, main)).has(generated.sha256)) {
      return { kind: "unmint", epoch: main, added: [] };
    }
    const againstMain = probeAgainst(pkg, capability, main, generated);
    if (againstMain.kind === "compatible") return { ...againstMain, kind: "unmint" };
    const againstOwn = probeAgainst(pkg, capability, epoch, generated);
    return againstOwn.kind === "compatible" ? againstOwn : { ...againstOwn, kind: "refresh" };
  }
  return probeAgainst(pkg, capability, epoch, generated);
}

/** Mint (or re-mint in place) epoch `version` from `generated`. */
function mintRecord(pkg, capability, version, generated) {
  writeEpoch(pkg, capability, version, epochRecord(capability, version, generated));
  writeRollup(pkg, capability, version, generated.body);
}

/**
 * Put this branch's epochs for one capability back to the merge-base's: every
 * epoch minted here is deleted and main's contract entry is returned — or
 * `undefined` when nothing was minted here.
 */
function discardBranchEpochs(pkg, capability, contract) {
  const state = branchState(pkg, capability);
  if (state.base === null || state.epochOnMain(latestEpoch(contract))) return;
  for (let v = state.baseLatest + 1; v <= latestEpoch(contract); v += 1) {
    rmSync(epochPath(pkg, capability, v), { force: true });
    rmSync(rollupPath(pkg, capability, v), { force: true });
    removeFixtures(pkg, capability, v);
  }
  return state.base;
}

/**
 * `--unbump`: discard the epoch this branch minted for one capability, whose
 * change turned out compatible with main's epoch. Returns main's contract
 * entry for the caller to write.
 */
export function unbump(pkg, capability, contract, outcome) {
  const restored = discardBranchEpochs(pkg, capability, contract) ?? contract;
  // Main's current epoch is current again and owes no example; one this
  // branch scaffolded for it evidenced a promise withdrawn with the epoch.
  removeFixtures(pkg, capability, outcome.epoch);
  return restored;
}

/**
 * The epoch a `--bump` lands on, and the new contract entry: this branch's
 * epochs discarded first (G4), then back onto a supported epoch whose hash the
 * surface returned to, else one new epoch past the latest.
 *
 * @returns {{ contract: import("./_api-contracts-tree.mjs").CapabilityEpochs, target: number, previous: number, pointedBack: boolean, restored: boolean }}
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
