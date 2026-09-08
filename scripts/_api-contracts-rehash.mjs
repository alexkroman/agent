#!/usr/bin/env node

/**
 * `--rehash`: the migration a change to the HASH RULE owes.
 *
 * Its own module because it is a different kind of operation from the commands
 * beside it in the CLI. `--init`, `--bump` and `--retire` each record a
 * decision somebody made about the SURFACE; this one records that the QUESTION
 * changed. It therefore carries more caveats than any of them, and they read
 * better at the top of a file than buried among four other modes.
 */

import { generateCapabilityReports } from "./_api-contracts.mjs";
import { classify } from "./_api-contracts-checks.mjs";
import {
  capabilities,
  capabilityId,
  epochRecord,
  readEpoch,
  readTable,
  writeEpoch,
} from "./_api-contracts-tree.mjs";

/**
 * Recompute every current epoch's hash WITHOUT bumping it.
 *
 * For exactly one situation: `_api-contracts-hash.mjs` changed what the hash is
 * taken over, so EVERY committed hash stops matching at once while not one
 * published signature moved. Bumping there would burn an epoch per capability
 * and write one drop reason each saying "the hash rule changed" — the noise
 * that file exists to remove, recorded as though it were a compatibility
 * decision.
 *
 * Two things keep this from laundering a real change. It REFUSES any capability
 * whose export list has moved, because that is a surface change and `--bump`
 * owns it. And it is only sound from a tree where the gate was GREEN before the
 * rule changed: green means every committed hash already matched the surface,
 * so a recomputation cannot be hiding a signature that moved with it. Run it in
 * the same commit as the rule change, never in one that also touches the
 * surface — the diff makes that reviewable, since a rehash shows as changed
 * `sha256` fields under unchanged epoch numbers and nothing else.
 */
export function rehash(packages, reason) {
  if (reason === undefined || reason.trim() === "") {
    console.error(
      'api-contracts: `--rehash` needs `--because "<reason>"` naming the change to the hash ' +
        "rule.\n  It rewrites committed hashes in place; a future reader needs to know why.",
    );
    process.exit(1);
  }

  const rewritten = [];
  for (const pkg of packages) {
    const table = readTable(pkg);
    const reports = generateCapabilityReports(pkg);
    for (const capability of capabilities(pkg)) {
      const id = capabilityId(pkg, capability);
      const epoch = table[capability].current;
      const committed = readEpoch(pkg, capability, epoch);
      const generated = reports.get(capability);
      const { added, removed } = classify(committed.exports ?? [], generated.exports);
      if (added.length > 0 || removed.length > 0) {
        console.error(
          `api-contracts: "${id}" has export-list changes (${[...removed.map((n) => `-${n}`), ...added.map((n) => `+${n}`)].join(", ")}).\n` +
            "  That is a surface change, not a hash-rule change. Classify it with `--bump`, " +
            "and rehash from a green tree.",
        );
        process.exit(1);
      }
      if (committed.sha256 === generated.sha256) continue;
      writeEpoch(pkg, capability, epoch, epochRecord(capability, epoch, generated));
      rewritten.push(`${id}@${epoch}`);
    }
  }

  console.log(
    `api-contracts: rehashed ${rewritten.length} current epoch(s) in place — ${reason}\n` +
      `  No epoch was bumped and no export list moved.\n  ${rewritten.join(" ") || "(none)"}`,
  );
}
