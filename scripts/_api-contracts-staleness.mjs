#!/usr/bin/env node

/**
 * Is each capability's committed epoch still the truth, and if not, what
 * settles it? Split from `_api-contracts-checks.mjs`, which holds the checks
 * over the contract TABLE; these are the ones over an epoch's HASH, its pinned
 * rollup, and how this branch moved it against the merge-base.
 *
 * Each returns its findings rather than recording them, so the caller decides
 * the order.
 */

import { existsSync } from "node:fs";

import { baseEpoch, branchState } from "./_api-contracts-base.mjs";
import { branchGrowth } from "./_api-contracts-epochs.mjs";
import { HASH_RULE } from "./_api-contracts-hash.mjs";
import { verdict } from "./_api-contracts-mint.mjs";
import {
  capabilityId,
  epochPath,
  latestEpoch,
  readEpoch,
  readRollup,
  rel,
  rollupPath,
  sha256Of,
} from "./_api-contracts-tree.mjs";

/** Added and removed export names between two epochs, and what they imply. */
export function classify(previous, next) {
  const before = new Set(previous);
  const after = new Set(next);
  const removed = previous.filter((name) => !after.has(name));
  const added = next.filter((name) => !before.has(name));
  let bump = "patch or minor";
  if (removed.length > 0) bump = "major";
  else if (added.length > 0) bump = "minor";
  return { added, removed, bump };
}

/**
 * The current epoch is hashed under this rule and pins the rollup it was
 * minted from — the OLD side of every compatibility probe, so an edited or
 * missing one would let a revision be proven against the wrong thing.
 */
function checkRollup(pkg, capability, current, committed, fail) {
  const path = rollupPath(pkg, capability, current);
  if (committed.rule !== HASH_RULE) {
    fail(
      `${rel(epochPath(pkg, capability, current))} was hashed under rule ${committed.rule ?? 1}, ` +
        `not ${HASH_RULE}. Run \`node scripts/api-contracts.mjs --rehash --because "<reason>"\`.`,
    );
    return false;
  }
  const body = readRollup(pkg, capability, current);
  if (body === undefined || sha256Of(body) !== committed.rollup) {
    fail(
      `${rel(path)} ${body === undefined ? "is missing" : "does not match the sha its epoch pins"}. ` +
        "It is the rollup the epoch was minted from and the baseline every revision is proven " +
        "against; restore it from git rather than regenerating it.",
    );
    return false;
  }
  return true;
}

/** What a stale capability's message says to do, by verdict. */
function staleAdvice(id, current, outcome) {
  const update = "    node scripts/api-contracts.mjs --update";
  switch (outcome.kind) {
    case "restore":
      return `  It matches the merge-base's record again. Restore it:\n${update}`;
    case "unmint":
      return `  Epoch ${current} was minted on this branch, and the change is compatible with main's epoch ${outcome.epoch} after all. Discard it:\n${update}`;
    case "refresh":
      return `  Epoch ${current} was minted on this branch; rewrite it in place:\n${update}`;
    case "revision":
      return (
        "  The change is BACKWARD COMPATIBLE (checked" +
        (outcome.added.length > 0 ? `; adds ${outcome.added.join(", ")}` : "") +
        `), so it is a revision of epoch ${current}, not a new epoch. Record it:\n${update}`
      );
    default:
      return (
        `  It is NOT provably compatible with epoch ${current}:\n    ` +
        (outcome.kind === "break" ? outcome.problems.slice(0, 12).join("\n    ") : outcome.why) +
        "\n  Classify it, which is the whole point of this gate:\n" +
        `    node scripts/api-contracts.mjs --bump ${id} --drop "<reason>"\n` +
        `      records that epoch ${current} no longer compiles, and why.\n` +
        `    node scripts/api-contracts.mjs --bump ${id} --retain\n` +
        "      asserts it still does, and obliges a frozen example that proves it."
      );
  }
}

/** The whole finding for one stale capability: what moved, and what settles it. */
function staleMessage(pkg, capability, contract, committed, generated) {
  const id = capabilityId(pkg, capability);
  const { added, removed, bump: byExports } = classify(committed.exports ?? [], generated.exports);
  const detail = [
    removed.length > 0 ? `\n  removed: ${removed.join(", ")}` : "",
    added.length > 0 ? `\n  added:   ${added.join(", ")}` : "",
  ].join("");
  const outcome = verdict(pkg, capability, contract, generated);
  const bump = outcome.kind === "break" ? "major (the probe found a break)" : byExports;
  return (
    `The "${id}" capability no longer matches epoch ${contract.current}.${detail}\n` +
    `  Likely changeset bump: ${bump}.\n${staleAdvice(id, contract.current, outcome)}`
  );
}

/**
 * The generated report for each capability still matches its current epoch.
 *
 * A mismatch always FAILS — the committed record is stale, exactly like a
 * stale API report — but the message now says which command settles it:
 * `--update` when the change is provably compatible (a revision), `--bump`
 * only when it is not.
 */
export function checkEpochs(pkg, table, reports) {
  const issues = [];
  const fail = (message) => issues.push(message);
  for (const [capability, contract] of Object.entries(table)) {
    const { current } = contract;
    const generated = reports.get(capability);
    if (generated === undefined) continue;
    const path = epochPath(pkg, capability, current);
    if (!existsSync(path)) continue; // checkInventory already reported it.
    const committed = readEpoch(pkg, capability, current);
    if (!checkRollup(pkg, capability, current, committed, fail)) continue;
    if (committed.sha256 === generated.sha256) continue;

    fail(staleMessage(pkg, capability, contract, committed, generated));
  }
  return issues;
}

/**
 * At most ONE new epoch, and one new revision, per capability per branch.
 *
 * `--bump` and `--update` never stack a second (they rewrite this branch's in
 * place), so this only fires on a hand edit or an old flow — which is exactly
 * how `aai:llm` went v4 to v7 on one PR. Silent without a merge-base.
 */
export function checkBranch(pkg, table) {
  const issues = [];
  const fail = (message) => issues.push(message);
  for (const [capability, contract] of Object.entries(table)) {
    const state = branchState(pkg, capability);
    if (state.base === null) continue;
    const id = capabilityId(pkg, capability);
    const onMain = state.epochOnMain(contract.current)
      ? baseEpoch(epochPath(pkg, capability, contract.current))
      : undefined;
    const record = readEpoch(pkg, capability, contract.current);
    const { minted, revised } = branchGrowth(contract, state.base ?? undefined, record, onMain);
    if (revised > 1) {
      fail(
        `"${id}" epoch ${contract.current} gained ${revised} revisions on this branch; a branch ` +
          "makes at most one. `--update` replaces this branch's revision rather than stacking one.",
      );
    }
    if (minted > 1) {
      fail(
        `"${id}" has ${minted} epochs this branch minted (${state.baseLatest + 1}..${latestEpoch(contract)}). ` +
          "An epoch is a promise made on main; supersede none of your own. Re-run the `--bump` " +
          "from main's state — it now rewrites this branch's epoch in place.",
      );
    }
  }
  return issues;
}
