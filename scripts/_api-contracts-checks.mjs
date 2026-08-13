#!/usr/bin/env node

/**
 * The checks `api-contracts.mjs` runs, as pure functions over the contract tree.
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
import {
  AUTHORING_SUBPATHS,
  authoringSurface,
  epochPath,
  FIXTURE_PLACEHOLDER,
  fixturePath,
  readEpoch,
  readInternalSurface,
  rel,
  TABLE_PATH,
} from "./_api-contracts.mjs";
import { compareNames } from "./_api-surface.mjs";

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
function checkCapabilitySet(table, present) {
  const declared = Object.keys(table).sort(compareNames);
  const found = present.slice().sort(compareNames);
  if (JSON.stringify(declared) === JSON.stringify(found)) return true;
  fail(
    `${rel(TABLE_PATH)} and contracts/entrypoints/ disagree.\n` +
      `  declared: ${declared.join(", ") || "(none)"}\n` +
      `  present:  ${found.join(", ") || "(none)"}\n` +
      "  Every capability entry point needs a contract entry, or it is unversioned.",
  );
  return false;
}

/** The `supported` list names real epochs, once each, including the current one. */
function checkSupported(where, current, supported) {
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
    if (!Number.isInteger(version) || version < 1 || version > current) {
      fail(`${where} lists supported epoch ${version}, which is not in 1..${current}.`);
      ok = false;
    }
  }
  return ok;
}

/** Every drop names a historical epoch and says why. */
function checkDropped(where, current, dropped) {
  let ok = true;
  for (const [version, reason] of Object.entries(dropped)) {
    if (Number(version) >= current || Number(version) < 1) {
      fail(`${where} drops epoch ${version}; only epochs before ${current} can be dropped.`);
      ok = false;
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      fail(`${where} must record WHY epoch ${version} was dropped.`);
      ok = false;
    }
  }
  return ok;
}

/** Each historical epoch is classified exactly once — supported or dropped. */
function checkClassification(where, current, supported, dropped) {
  let ok = true;
  for (let version = 1; version < current; version += 1) {
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

function checkTable(table, present) {
  if (!checkCapabilitySet(table, present)) return false;
  let ok = true;
  for (const [capability, contract] of Object.entries(table)) {
    const { current, supported = [], dropped = {} } = contract;
    const where = `contracts.json: capability "${capability}"`;
    if (!Number.isInteger(current) || current < 1) {
      fail(`${where} must have a positive integer \`current\` epoch.`);
      ok = false;
      continue;
    }
    ok = checkSupported(where, current, supported) && ok;
    ok = checkDropped(where, current, dropped) && ok;
    ok = checkClassification(where, current, supported, dropped) && ok;
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
function checkInventory(table) {
  for (const [capability, { current }] of Object.entries(table)) {
    const dir = dirname(epochPath(capability, 1));
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

/** A supported epoch is a promise, and a fixture is the evidence for it. */
function checkFixtures(table) {
  for (const [capability, { supported = [] }] of Object.entries(table)) {
    for (const version of supported) {
      const path = fixturePath(capability, version);
      if (!existsSync(path)) {
        fail(
          `${rel(path)} is missing. Advertising ${capability} epoch ${version} as supported ` +
            "requires a frozen authoring example that still compiles against current source — " +
            "otherwise the support is a claim with nothing behind it.",
        );
        continue;
      }
      if (readFileSync(path, "utf8").includes(FIXTURE_PLACEHOLDER)) {
        fail(
          `${rel(path)} is still the scaffold. Replace it with a representative ` +
            `${capability} epoch ${version} authoring example before advertising support.`,
        );
      }
    }
  }
}

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

/** The generated report for each capability still matches its current epoch. */
function checkEpochs(table, reports) {
  for (const [capability, { current }] of Object.entries(table)) {
    const generated = reports.get(capability);
    if (generated === undefined) continue;
    const path = epochPath(capability, current);
    if (!existsSync(path)) continue; // checkInventory already reported it.
    const committed = readEpoch(capability, current);
    if (committed.sha256 === generated.sha256) continue;

    const { added, removed, bump } = classify(committed.exports ?? [], generated.exports);
    const detail = [
      removed.length > 0 ? `  removed: ${removed.join(", ")}` : "",
      added.length > 0 ? `  added:   ${added.join(", ")}` : "",
      added.length === 0 && removed.length === 0
        ? "  the export list is unchanged, so this is a SIGNATURE change — read the report diff"
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    fail(
      `The "${capability}" capability no longer matches epoch ${current}.\n${detail}\n` +
        `  Likely changeset bump: ${bump}.\n` +
        "  Classify it, which is the whole point of this gate:\n" +
        `    node scripts/api-contracts.mjs --bump ${capability} --retain\n` +
        `      keeps epoch ${current} working, and obliges a frozen example that proves it.\n` +
        `    node scripts/api-contracts.mjs --bump ${capability} --drop "<reason>"\n` +
        `      records that epoch ${current} no longer compiles, and why.`,
    );
  }
}

/**
 * Every public authoring name belongs to exactly one capability.
 *
 * This is what makes the capability set a description of the surface rather
 * than a selection from it: a new `@public` export on any authoring subpath
 * fails until somebody decides which contract it joins, which is the same
 * decision as "who is promised this".
 */
function checkAssignment(entries) {
  const { publicNames, internalNames } = authoringSurface();
  const owner = new Map();
  for (const entry of entries) {
    for (const name of entry.names) {
      const existing = owner.get(name);
      if (existing !== undefined) {
        fail(
          `"${name}" is claimed by both the ${existing} and ${entry.capability} capabilities. ` +
            "A name belongs to exactly one contract, or a change to it bumps two epochs.",
        );
        continue;
      }
      owner.set(name, entry.capability);
    }
  }

  const unassigned = [...publicNames.keys()].filter((name) => !owner.has(name)).sort(compareNames);
  if (unassigned.length > 0) {
    fail(
      `${unassigned.length} public authoring export(s) belong to no capability:\n  ` +
        `${unassigned.join(", ")}\n` +
        "  Add each to the contracts/entrypoints/ file that owns it. If it is not part of " +
        "the authoring surface at all, tag it `@internal` in source instead.",
    );
  }

  const unknown = [...owner.keys()]
    .filter((name) => !(publicNames.has(name) || internalNames.has(name)))
    .sort(compareNames);
  if (unknown.length > 0) {
    fail(
      `${unknown.length} name(s) are claimed by a capability but exported by no authoring ` +
        `subpath (${Object.keys(AUTHORING_SUBPATHS).join(", ")}):\n  ${unknown.join(", ")}`,
    );
  }

  const leaked = [...owner.keys()].filter((name) => internalNames.has(name)).sort(compareNames);
  if (leaked.length > 0) {
    fail(
      `${leaked.length} name(s) are claimed by a capability but tagged \`@internal\`:\n  ` +
        `${leaked.join(", ")}\n` +
        "  Either it is authoring API — drop the tag — or it is not, and no contract may " +
        "promise it.",
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
function checkInternalSurface() {
  const { internalNames } = authoringSurface();
  const baseline = readInternalSurface();
  const current = internalSurfaceSnapshot(internalNames);
  for (const [subpath, names] of Object.entries(current.surface)) {
    const allowed = new Set(baseline.surface?.[subpath] ?? []);
    const added = names.filter((name) => !allowed.has(name));
    if (added.length > 0) {
      fail(
        `${added.length} new \`@internal\` export(s) on the public subpath "${subpath}":\n  ` +
          `${added.join(", ")}\n` +
          "  An @internal-tagged symbol is still importable and still in an author's " +
          "autocomplete. Move it to `@alexkroman1/aai/internal`, or promote it to a " +
          "capability. This baseline only shrinks.",
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
      `${stale.length} baselined \`@internal\` export(s) are gone. Give the headroom back with ` +
        "`node scripts/api-contracts.mjs --update-internal`:\n  " +
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
 * Every check, in the one order that makes sense.
 *
 * The epoch comparison is gated on the table being well-formed: a malformed
 * `current` would otherwise be reported once as a bad table and again as a
 * dozen missing-epoch failures, burying the finding that explains the rest.
 */
export function runChecks({ table, present, entries, reports }) {
  issues = [];
  warnings = [];
  if (checkTable(table, present)) {
    checkInventory(table);
    checkFixtures(table);
    checkEpochs(table, reports());
  }
  checkAssignment(entries);
  checkInternalSurface();
  return { issues, warnings };
}
