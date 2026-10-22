#!/usr/bin/env node

/**
 * The ARITHMETIC of epochs and revisions, with no filesystem and no git: what
 * a record or a contract entry becomes. `_api-contracts-mint.mjs` reads and
 * writes around these; `packages/aai-gates/src/api-contracts-epochs.test.ts`
 * exercises them directly, which is the reason they are pure.
 */

import { HASH_RULE } from "./_api-contracts-hash.mjs";

/**
 * Every hash one epoch has carried UNDER THE CURRENT RULE: the minted one and
 * each revision's (revisions are no longer written — a compatible change now
 * passes the gate unrecorded — but older records still carry them, and each is
 * a known-compatible sha the gate can skip probing). A sha from an older rule
 * is unreproducible, so comparing against it would be a coincidence.
 */
export function recordShas(record) {
  const shas = new Set();
  if ((record.rule ?? 1) === HASH_RULE) shas.add(record.sha256);
  for (const revision of record.revisions ?? []) {
    if ((revision.rule ?? record.rule ?? 1) === HASH_RULE) shas.add(revision.sha256);
  }
  return shas;
}

/**
 * The newest epoch a capability has, which is `current` unless a `--bump`
 * pointed `current` BACK at an older supported epoch whose shape the surface
 * returned to.
 */
export const latestEpoch = (contract) =>
  Math.max(
    contract.current,
    ...(contract.supported ?? []),
    ...Object.keys(contract.dropped ?? {}).map(Number),
  );

/**
 * Where a `--bump` from contract `from` lands: back on a SUPPORTED, non-current
 * epoch whose hash (any revision, this rule) equals `sha`, else one past the
 * latest. `shasOf(v)` answers {@link recordShas} for epoch `v`.
 */
export function bumpTarget(from, shasOf, sha) {
  const match = from.supported.find((v) => v !== from.current && shasOf(v).has(sha));
  return match === undefined
    ? { target: latestEpoch(from) + 1, pointedBack: false }
    : { target: match, pointedBack: true };
}

/** The contract entry after a `--bump` from `from` to `target`. */
export function bumpedContract(from, { target, retain, reason }) {
  const previous = from.current;
  const supported = from.supported.filter((v) => v !== target && (retain || v !== previous));
  const dropped = retain ? { ...from.dropped } : { ...from.dropped, [previous]: reason };
  delete dropped[target];
  return {
    current: target,
    supported: [...supported, target].sort((a, b) => a - b),
    dropped,
  };
}

/** How many epochs this branch added — the number `checkBranch` holds to one. */
export function branchGrowth(contract, baseContract) {
  const baseLatest = baseContract === undefined ? 0 : latestEpoch(baseContract);
  return { minted: latestEpoch(contract) - baseLatest };
}

/**
 * Whether a contract-table entry is a MIRROR: a capability whose entry point
 * only re-exports another package's capability (`{ "mirrors": "aai:testing" }`)
 * and so carries no hash, epoch or rollup of its own — see
 * `_api-contracts-mirror.mjs`.
 */
export const isMirror = (contract) => typeof contract?.mirrors === "string";
