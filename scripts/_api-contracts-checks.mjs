#!/usr/bin/env node

/**
 * The checks `api-contracts.mjs` runs, as pure functions over one package's
 * contract tree.
 *
 * Separated from the CLI so that file is the ORCHESTRATION and the mutating
 * modes — what a reader opens it for — rather than 300 lines of validation with
 * an entry point at the bottom. Every check returns its findings instead of
 * printing or exiting, which is also what lets `runChecks` decide the order and
 * short-circuit the epoch comparison when the table it rests on is malformed.
 *
 * `classify` and `internalSurfaceSnapshot` are exported because the bump and
 * bootstrap paths need them too: the first turns an export-list delta into a
 * suggested changeset bump, the second is both the baseline reader and the
 * thing `--update-internal` writes.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { authoringSurface } from "./_api-contracts.mjs";
import { checkOwnership, ownershipFindings } from "./_api-contracts-ownership.mjs";
import { checkBranch, checkEpochs } from "./_api-contracts-staleness.mjs";
import {
  authoringSubpaths,
  capabilityId,
  epochPath,
  FIXTURE_PLACEHOLDER,
  fixturePath,
  internalDestination,
  latestEpoch,
  readInternalSurface,
  rel,
} from "./_api-contracts-tree.mjs";
import { compareNames } from "./_api-surface.mjs";

export { classify } from "./_api-contracts-staleness.mjs";

/** Findings for one run. Reset by `runChecks`, appended to by every check. */
let issues = [];
let warnings = [];
const fail = (message) => issues.push(message);

/**
 * The contract table is well-formed, and every historical epoch is classified
 * exactly once.
 *
 * "Exactly once" is the load-bearing half. An epoch that is neither supported
 * nor dropped is one whose fate nobody decided, and it reads at a glance like
 * one that is fine; an epoch that is both is a contradiction the fixture
 * requirement would then silently enforce the strict half of.
 */
function checkCapabilitySet(pkg, table, present) {
  const declared = Object.keys(table).sort(compareNames);
  const found = present.slice().sort(compareNames);
  if (JSON.stringify(declared) === JSON.stringify(found)) return true;
  fail(
    `${rel(pkg.tablePath)} and ${rel(pkg.entrypointRoot)}/ disagree.\n` +
      `  declared: ${declared.join(", ") || "(none)"}\n` +
      `  present:  ${found.join(", ") || "(none)"}\n` +
      "  Every capability entry point needs a contract entry, or it is unversioned.",
  );
  return false;
}

/**
 * The `supported` list names real epochs, once each, including the current one.
 *
 * `latest` is not always `current`: a `--bump` whose hash equals a supported
 * epoch's points `current` BACK at it rather than minting a copy, so epochs
 * newer than `current` can exist, each classified like any other.
 */
function checkSupported(where, current, supported, latest) {
  let ok = true;
  if (!supported.includes(current)) {
    fail(`${where} does not list its current epoch ${current} as supported.`);
    ok = false;
  }
  if (new Set(supported).size !== supported.length) {
    fail(`${where} lists a supported epoch more than once.`);
    ok = false;
  }
  for (const version of supported) {
    if (!Number.isInteger(version) || version < 1 || version > latest) {
      fail(`${where} lists supported epoch ${version}, which is not in 1..${latest}.`);
      ok = false;
    }
  }
  return ok;
}

/** Every drop names a non-current epoch and says why. */
function checkDropped(where, current, dropped) {
  let ok = true;
  for (const [version, reason] of Object.entries(dropped)) {
    if (Number(version) === current || Number(version) < 1 || !Number.isInteger(Number(version))) {
      fail(`${where} drops epoch ${version}; only a real, non-current epoch can be dropped.`);
      ok = false;
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      fail(`${where} must record WHY epoch ${version} was dropped.`);
      ok = false;
    }
  }
  return ok;
}

/** Each non-current epoch is classified exactly once — supported or dropped. */
function checkClassification(where, current, supported, dropped, latest) {
  let ok = true;
  for (let version = 1; version <= latest; version += 1) {
    if (version === current) continue;
    const isSupported = supported.includes(version);
    const isDropped = Object.hasOwn(dropped, version);
    if (isSupported === isDropped) {
      fail(
        `${where} epoch ${version} must be classified exactly once — supported or dropped, ` +
          `not ${isSupported ? "both" : "neither"}.`,
      );
      ok = false;
    }
  }
  return ok;
}

function checkTable(pkg, table, present) {
  if (!checkCapabilitySet(pkg, table, present)) return false;
  let ok = true;
  for (const [capability, contract] of Object.entries(table)) {
    const { current, supported = [], dropped = {} } = contract;
    const where = `${rel(pkg.tablePath)}: capability "${capability}"`;
    if (!Number.isInteger(current) || current < 1) {
      fail(`${where} must have a positive integer \`current\` epoch.`);
      ok = false;
      continue;
    }
    const latest = latestEpoch({ current, supported, dropped });
    ok = checkSupported(where, current, supported, latest) && ok;
    ok = checkDropped(where, current, dropped) && ok;
    ok = checkClassification(where, current, supported, dropped, latest) && ok;
  }
  return ok;
}

/**
 * Every epoch from 1 to current still has its metadata, and nothing beyond it
 * does.
 *
 * Retention is the point: the record of what the API looked like two breaking
 * changes ago is the only thing that makes "when did this move" answerable
 * without a git archaeology session.
 */
function checkInventory(pkg, table) {
  for (const [capability, contract] of Object.entries(table)) {
    const current = latestEpoch(contract);
    const dir = dirname(epochPath(pkg, capability, 1));
    const expected = Array.from({ length: current }, (_, index) => `v${index + 1}.json`).sort();
    const actual = existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".json"))
          .sort()
      : [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(
        `${rel(dir)} must hold exactly v1..v${current}.\n` +
          `  expected: ${expected.join(", ")}\n` +
          `  found:    ${actual.join(", ") || "(none)"}\n` +
          "  Epoch metadata is immutable — restore the missing file rather than renumbering.",
      );
    }
  }
}

/**
 * A supported epoch is a promise, and a fixture is the evidence for it.
 *
 * The CURRENT epoch is exempt, and the distinction is the whole point: an
 * example proves that source written against an OLD epoch still compiles, which
 * is a claim only a superseded epoch can make. For the current one the claim is
 * "today's API compiles", which `pnpm typecheck` proves over the real source and
 * a frozen copy restates.
 *
 * It used to be required from an epoch's first commit, on the argument that the
 * value should not wait for a bump. What that bought at v1 was one file per
 * capability asserting that the shape in the report is the shape in the tree —
 * and what it cost was visible at the reset: 129 frozen examples, none of them
 * evidence for any promise, because nothing had shipped for them to be
 * compatible WITH. `bump --retain` scaffolds the retained epoch's example at the
 * moment it becomes a promise, which is when there is something to write.
 */
function checkFixtures(pkg, table) {
  for (const [capability, { supported = [], current }] of Object.entries(table)) {
    for (const version of supported) {
      if (version === current) continue;
      const path = fixturePath(pkg, capability, version);
      if (!existsSync(path)) {
        fail(
          `${rel(path)} is missing. Advertising ${capabilityId(pkg, capability)} epoch ${version} ` +
            "as supported requires a frozen authoring example that still compiles against " +
            "current source — otherwise the support is a claim with nothing behind it.",
        );
        continue;
      }
      if (readFileSync(path, "utf8").includes(FIXTURE_PLACEHOLDER)) {
        fail(
          `${rel(path)} is still the scaffold. Replace it with a representative ` +
            `${capabilityId(pkg, capability)} epoch ${version} authoring example before ` +
            "advertising support.",
        );
      }
    }
  }
}

/**
 * Every public authoring name of one package belongs to exactly one of its
 * capabilities.
 *
 * This is what makes the capability set a description of the surface rather
 * than a selection from it: a new `@public` export on any authoring subpath
 * fails until somebody decides which contract it joins, which is the same
 * decision as "who is promised this".
 *
 * Ownership is per PACKAGE, deliberately. `isTerminal`, `WorkflowSummary` and
 * `WorkflowOutputOf` are on both packages' surfaces (`aai-ui` re-exports them
 * from the SDK), and both packages have a `workflow` capability — the same
 * concept reached from the two sides of the wire, versioned separately, because
 * a change can break an author on one side and not the other.
 */
function checkAssignment(pkg, entries) {
  const { publicNames, internalNames } = authoringSurface(pkg);
  const owner = new Map();
  for (const entry of entries) {
    for (const name of entry.names) {
      const existing = owner.get(name);
      if (existing !== undefined) {
        fail(
          `"${name}" is claimed by both the ${capabilityId(pkg, existing)} and ` +
            `${capabilityId(pkg, entry.capability)} capabilities. A name belongs to exactly one ` +
            "contract, or a change to it bumps two epochs.",
        );
        continue;
      }
      owner.set(name, entry.capability);
    }
  }

  const unassigned = [...publicNames.keys()].filter((name) => !owner.has(name)).sort(compareNames);
  if (unassigned.length > 0) {
    fail(
      `${unassigned.length} public authoring export(s) of ${pkg.name} belong to no capability:\n  ` +
        `${unassigned.join(", ")}\n` +
        `  Add each to the ${rel(pkg.entrypointRoot)}/ file that owns it. If it is not part of ` +
        "the authoring surface at all, tag it `@internal` in source instead.",
    );
  }

  const subpaths = Object.keys(authoringSubpaths(pkg)).join(", ");
  const unknown = [...owner.keys()]
    .filter((name) => !(publicNames.has(name) || internalNames.has(name)))
    .sort(compareNames);
  if (unknown.length > 0) {
    fail(
      `${unknown.length} name(s) are claimed by a ${pkg.name} capability but exported by no ` +
        `authoring subpath (${subpaths}):\n  ${unknown.join(", ")}`,
    );
  }

  const destination = internalDestination(pkg);
  const leaked = [...owner.keys()].filter((name) => internalNames.has(name)).sort(compareNames);
  if (leaked.length > 0) {
    fail(
      `${leaked.length} name(s) are claimed by a ${pkg.name} capability but tagged ` +
        `\`@internal\`:\n  ${leaked.join(", ")}\n` +
        "  Either it is authoring API — drop the tag — or it is not, and no contract may " +
        `promise it${destination === null ? "" : ` (move it to \`${destination}\`)`}.`,
    );
  }
}

/**
 * The `@internal`-on-a-public-barrel count is a ratchet.
 *
 * These are exports a consumer can import and autocomplete over, that no
 * contract covers and no changeset protects. The tag is a note to ourselves,
 * and a note is not a limit — so the set is committed, additions fail, and
 * removals are recorded with `--update-internal`. It may only shrink.
 */
function checkInternalSurface(pkg) {
  const { internalNames } = authoringSurface(pkg);
  const baseline = readInternalSurface(pkg);
  const current = internalSurfaceSnapshot(internalNames);
  const destination = internalDestination(pkg);
  for (const [subpath, names] of Object.entries(current.surface)) {
    const allowed = new Set(baseline.surface?.[subpath] ?? []);
    const added = names.filter((name) => !allowed.has(name));
    if (added.length > 0) {
      fail(
        `${added.length} new \`@internal\` export(s) on ${pkg.name}'s public subpath ` +
          `"${subpath}":\n  ${added.join(", ")}\n` +
          "  An @internal-tagged symbol is still importable and still in an author's " +
          `autocomplete. ${destination === null ? "Move it behind a private module" : `Move it to \`${destination}\``}` +
          ", or promote it to a capability. This baseline only shrinks.",
      );
    }
  }
  const stale = Object.entries(baseline.surface ?? {}).flatMap(([subpath, names]) => {
    const live = new Set(current.surface[subpath] ?? []);
    return names.filter((name) => !live.has(name)).map((name) => `${subpath} ${name}`);
  });
  if (stale.length > 0) {
    // A WARNING, not a failure: unclaimed headroom is a hatch the next branch
    // gets for free, but refusing the build over debt somebody already paid
    // down would be perverse. Same contract as `check-escape-hatches`.
    warnings.push(
      `${stale.length} baselined \`@internal\` export(s) of ${pkg.name} are gone. Give the ` +
        "headroom back with `node scripts/api-contracts.mjs --update-internal`:\n  " +
        `${stale.join("\n  ")}`,
    );
  }
}

export function internalSurfaceSnapshot(internalNames) {
  const surface = {};
  for (const [name, subpaths] of internalNames) {
    for (const subpath of subpaths) {
      surface[subpath] ??= [];
      surface[subpath].push(name);
    }
  }
  for (const names of Object.values(surface)) names.sort(compareNames);
  return {
    comment:
      "Exports tagged @internal that are nonetheless reachable from a public subpath. " +
      "Ratchet: this list may shrink and may never grow. See scripts/api-contracts.mjs.",
    total: internalNames.size,
    surface: Object.fromEntries(Object.entries(surface).sort()),
  };
}

/**
 * Every check for one package, in the one order that makes sense.
 *
 * The epoch comparison is gated on the table being well-formed: a malformed
 * `current` would otherwise be reported once as a bad table and again as a
 * dozen missing-epoch failures, burying the finding that explains the rest.
 */
export function runChecks({ pkg, table, present, entries, reports }) {
  issues = [];
  warnings = [];
  if (checkTable(pkg, table, present)) {
    checkInventory(pkg, table);
    checkFixtures(pkg, table);
    issues.push(...checkBranch(pkg, table));
    const generated = reports();
    issues.push(...checkEpochs(pkg, table, generated));
    const ownership = checkOwnership(pkg, ownershipFindings(pkg, generated));
    issues.push(...ownership.issues);
    warnings.push(...ownership.warnings);
  }
  checkAssignment(pkg, entries);
  checkInternalSurface(pkg);
  return { issues, warnings };
}
