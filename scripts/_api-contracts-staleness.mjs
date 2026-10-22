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
import { join } from "node:path";

import { omitUndefined } from "../packages/aai/src/sdk/omit-undefined.ts";
import { parseEntrypoint } from "./_api-contracts.mjs";
import { atBase, branchState } from "./_api-contracts-base.mjs";
import { probeCompatibility } from "./_api-contracts-compat.mjs";
import { branchGrowth, isMirror } from "./_api-contracts-epochs.mjs";
import { HASH_RULE } from "./_api-contracts-hash.mjs";
import { verdict } from "./_api-contracts-mint.mjs";
import { entrypointNames, mirrorProblems, parseMirrorTarget } from "./_api-contracts-mirror.mjs";
import {
  capabilities,
  capabilityId,
  contractPackages,
  epochPath,
  latestEpoch,
  readEpoch,
  readRollup,
  readTable,
  recordShas,
  rel,
  rollupPath,
  sha256Of,
} from "./_api-contracts-tree.mjs";

/**
 * The bump a breaking change suggests. While the published packages are on
 * `0.x` a break is a `minor` — `major` would release 1.0.0, and rule 20 of
 * `guard-invariants` refuses it (`checkChangesetPreRelease`).
 */
export const BREAKING_BUMP = "major (minor while on 0.x)";

/** Added and removed export names between two epochs, and what they imply. */
export function classify(previous, next) {
  const before = new Set(previous);
  const after = new Set(next);
  const removed = previous.filter((name) => !after.has(name));
  const added = next.filter((name) => !before.has(name));
  let bump = "patch or minor";
  if (removed.length > 0) bump = BREAKING_BUMP;
  else if (added.length > 0) bump = "minor";
  return { added, removed, bump };
}

/**
 * The current epoch is hashed under this rule and pins the rollup it was
 * minted from — the OLD side of every compatibility probe, so an edited or
 * missing one would let a change be proven against the wrong thing.
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
        "It is the rollup the epoch was minted from and the baseline every later change is " +
        "proven against; restore it from git rather than regenerating it.",
    );
    return false;
  }
  return true;
}

/**
 * The pinned rollup still COMPILES against today's tree: it probes compatible
 * against itself.
 *
 * A rollup imports its sibling packages by specifier, and those resolve to
 * their CURRENT `dist` — so when `@alexkroman1/aai/protocol` stopped exporting
 * `SessionEvent`, five `aai-runtime` rollups stopped compiling with no change
 * of their own. The probe now re-points a workspace import at whichever
 * subpath exports the name today (`_api-contracts-imports.mjs`), so a MOVED
 * name re-pins itself in memory; what is left for this check is a name that
 * left its package, or a third-party type that changed under us — the first
 * moved hash would otherwise be probed against a baseline full of errors and
 * read as a break nobody made.
 */
function checkRollupCompiles(pkg, capability, current, fail) {
  const body = readRollup(pkg, capability, current);
  if (body === undefined) return;
  const probe = probeCompatibility({ oldBody: body, newBody: body, dir: pkg.dir });
  if (probe.compatible) return;
  fail(
    `${rel(rollupPath(pkg, capability, current))} no longer compiles against the current tree ` +
      `(it does not probe compatible with ITSELF):\n    ${probe.problems.slice(0, 6).join("\n    ")}\n` +
      "  A subpath move is re-pinned automatically, so something it imports left its package " +
      "(or a third-party type moved). RE-PIN it: edit the rollup as little as it takes to " +
      "compile — the import's new source, never the declarations — then set `rollup` in " +
      `${rel(epochPath(pkg, capability, current))} to the new text's sha256 (the file minus its ` +
      "trailing newline). The capability's `sha256` does not move: it is taken from today's " +
      "report, not from the rollup.",
  );
}

/** What a capability that is NOT provably compatible owes, by verdict. */
function staleAdvice(id, current, outcome) {
  switch (outcome.kind) {
    case "unmint":
      return (
        `  Epoch ${current} was minted on this branch, but the change is compatible with main's ` +
        `epoch ${outcome.epoch} after all, so it promises nothing new. Discard it:\n` +
        `    node scripts/api-contracts.mjs --unbump ${id}`
      );
    case "refresh":
      return (
        `  Epoch ${current} was minted on this branch and the surface has moved again, past ` +
        `what it recorded:\n    ${outcome.problems?.slice(0, 12).join("\n    ") ?? outcome.why}\n` +
        "  Re-run the `--bump` you made; it rewrites this branch's epoch in place:\n" +
        `    node scripts/api-contracts.mjs --bump ${id} --drop "<reason>"   (or --retain)`
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

/** The whole finding for one capability that needs a decision. */
function staleMessage(id, contract, committed, generated, outcome) {
  const { added, removed, bump: byExports } = classify(committed.exports ?? [], generated.exports);
  const detail = [
    removed.length > 0 ? `\n  removed: ${removed.join(", ")}` : "",
    added.length > 0 ? `\n  added:   ${added.join(", ")}` : "",
  ].join("");
  const bump = outcome.kind === "break" ? `${BREAKING_BUMP} — the probe found a break` : byExports;
  return (
    `The "${id}" capability no longer matches epoch ${contract.current}.${detail}\n` +
    `  Likely changeset bump: ${bump}.\n${staleAdvice(id, contract.current, outcome)}`
  );
}

/**
 * Each capability's surface is still promised by its current epoch.
 *
 * The record's sha is a FAST PATH: equal to any hash the epoch has carried
 * under this rule, the surface has not moved and nothing is probed. Otherwise
 * the new rollup is probed against the epoch's pinned ORIGINAL rollup, and a
 * compatible verdict PASSES with nothing written — it is reported in `notes`,
 * with the export-list delta a changeset will want. Only a change the probe
 * cannot prove compatible fails, naming the `--bump` (or `--unbump`) that
 * settles it.
 *
 * @returns {{ issues: string[], notes: string[] }}
 */
export function checkEpochs(pkg, table, reports) {
  const issues = [];
  const notes = [];
  for (const [capability, contract] of Object.entries(table)) {
    const generated = reports.get(capability);
    if (isMirror(contract) || generated === undefined) continue;
    checkOneEpoch(pkg, capability, contract, generated, { issues, notes });
  }
  return { issues, notes };
}

/** {@link checkEpochs} for one epoched capability. */
function checkOneEpoch(pkg, capability, contract, generated, { issues, notes }) {
  const fail = (message) => issues.push(message);
  const { current } = contract;
  if (!existsSync(epochPath(pkg, capability, current))) return; // checkInventory reported it.
  const committed = readEpoch(pkg, capability, current);
  if (!checkRollup(pkg, capability, current, committed, fail)) return;
  checkRollupCompiles(pkg, capability, current, fail);
  if (recordShas(committed).has(generated.sha256)) return;

  const id = capabilityId(pkg, capability);
  const outcome = verdict(pkg, capability, contract, generated);
  if (outcome.kind !== "compatible") {
    fail(staleMessage(id, contract, committed, generated, outcome));
    return;
  }
  const additions = outcome.added ?? [];
  const added = additions.length > 0 ? `; adds ${additions.join(", ")}` : "";
  notes.push(`${id}@${current}: moved, compatible with epoch ${outcome.epoch} (checked${added})`);
}

/**
 * At most ONE new epoch per capability per branch.
 *
 * `--bump` never stacks a second (it rewrites this branch's in place), so this
 * only fires on a hand edit or an old flow — which is exactly how `aai:llm`
 * went v4 to v7 on one PR. Silent without a merge-base.
 */
export function checkBranch(pkg, table) {
  const issues = [];
  for (const [capability, contract] of Object.entries(table)) {
    if (isMirror(contract)) continue;
    const state = branchState(pkg, capability);
    if (state.base === null) continue;
    const { minted } = branchGrowth(contract, state.base ?? undefined);
    if (minted > 1) {
      issues.push(
        `"${capabilityId(pkg, capability)}" has ${minted} epochs this branch minted ` +
          `(${state.baseLatest + 1}..${latestEpoch(contract)}). An epoch is a promise made on ` +
          "main; supersede none of your own. Re-run the `--bump` from main's state — it now " +
          "rewrites this branch's epoch in place.",
      );
    }
  }
  return issues;
}

/**
 * Every MIRROR capability is pure, carries only what its upstream contracts
 * today, and drops nothing upstream still exports (`_api-contracts-mirror.mjs`).
 */
/** The epoched capability of ANOTHER package a mirror names, or `undefined`. */
function mirrorUpstream(pkg, contract) {
  const target = parseMirrorTarget(contract.mirrors);
  if (target === undefined) return;
  const upstream = contractPackages().find((candidate) => candidate.key === target.key);
  if (upstream === undefined || upstream.key === pkg.key) return;
  if (!capabilities(upstream).includes(target.capability)) return;
  if (isMirror(readTable(upstream)[target.capability])) return;
  return { upstream, capability: target.capability };
}

export function checkMirrors(pkg, table, reports) {
  const issues = [];
  for (const [capability, contract] of Object.entries(table)) {
    if (!isMirror(contract)) continue;
    const id = capabilityId(pkg, capability);
    const resolved = mirrorUpstream(pkg, contract);
    if (resolved === undefined) {
      issues.push(
        `${rel(pkg.tablePath)}: "${capability}" mirrors "${contract.mirrors}", which is not an ` +
          "epoched capability of ANOTHER contract package. Name it `<package>:<capability>`.",
      );
      continue;
    }
    const generated = reports.get(capability);
    if (generated === undefined) continue;
    const entrypoint = join(pkg.entrypointRoot, `${capability}.ts`);
    const baseText = atBase(entrypoint);
    issues.push(
      ...mirrorProblems({
        id,
        target: String(contract.mirrors),
        body: generated.body,
        upstreamPackage: String(resolved.upstream.name),
        upstreamNames: parseEntrypoint(resolved.upstream, resolved.capability).names,
        ...omitUndefined({
          baseNames: baseText === undefined ? undefined : entrypointNames(baseText),
        }),
      }),
    );
    if (existsSync(join(pkg.epochRoot, capability))) {
      issues.push(
        `${rel(join(pkg.epochRoot, capability))}/ exists, but "${id}" is a mirror and carries no ` +
          "epoch of its own. Delete the directory.",
      );
    }
  }
  return issues;
}
