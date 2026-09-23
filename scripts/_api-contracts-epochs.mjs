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
 * each revision's. A sha from an older rule is unreproducible, so comparing
 * against it would be a coincidence rather than a match.
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
 * `from` revised to `generated`'s hash and export list.
 *
 * `from` is the record ON MAIN when there is one, so a second revision on one
 * branch REPLACES the first instead of stacking (G4); its rollup and epoch
 * number are never touched — every revision is proven against the rollup the
 * epoch was minted from.
 */
export function revisedRecord(from, generated, added) {
  const history = from.revisions ?? [
    { revision: 0, rule: from.rule ?? 1, sha256: from.sha256, reason: "minted" },
  ];
  const revision = (from.revision ?? 0) + 1;
  const reason =
    added.length > 0
      ? `additive (checked): +${added.join(", +")}`
      : "compatible (checked): no export added or removed; every old export still assignable";
  return {
    ...from,
    rule: HASH_RULE,
    sha256: generated.sha256,
    exports: generated.exports,
    revision,
    revisions: [...history, { revision, rule: HASH_RULE, sha256: generated.sha256, reason }],
  };
}

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

/**
 * How many epochs, and how many revisions of main's current epoch, this branch
 * added — the numbers `checkBranch` holds to one each.
 */
export function branchGrowth(contract, baseContract, record, mainRecord) {
  const baseLatest = baseContract === undefined ? 0 : latestEpoch(baseContract);
  return {
    minted: latestEpoch(contract) - baseLatest,
    revised: mainRecord === undefined ? 0 : (record.revision ?? 0) - (mainRecord.revision ?? 0),
  };
}
