#!/usr/bin/env node

/**
 * Every declaration a capability's hash covers must have exactly ONE owner.
 *
 * A capability's rollup inlines three kinds of declaration: its own exports,
 * types a SIBLING capability contracts (hashed as a name only — see
 * `_api-contracts-hash.mjs`), and types NO capability contracts. The third kind
 * is hashed by body in every capability that reaches it, which is how one
 * change to `SessionEventSchema` — exported only from `/protocol`, a subpath no
 * capability covers — became three epochs (`agent`, `dialog`, `metrics`), and
 * how `StandardSchemaV1` sits in eight capabilities' hashes at once.
 *
 * Two findings, one per way a type ends up ownerless, both failures:
 *
 * - **unowned** (G2): exported by SOME published subpath of the package, but
 *   selected by no capability entry point. The remedy is an owner — add it to
 *   the capability it belongs to (from an authoring subpath), or, for a
 *   non-authoring subpath like `/protocol`, contract that subpath.
 * - **forgotten** (G6): exported by NO published subpath — API Extractor's
 *   `ae-forgotten-export`, restricted to the types no consumer can import at
 *   all. A consumer must satisfy the shape and cannot name it. The remedy is
 *   to export it and give it an owner. `--bump` and `--update` REFUSE a
 *   capability while it reaches one that is not baselined: that state minted
 *   `aai-runtime:eval` v4 and then v5, the second to fix the first.
 *
 * The offenders that already exist are committed in
 * `src/contracts/unowned-surface.json`, a ratchet that may SHRINK and never
 * grow (`--update-internal` lowers it; it never adds). A name in either list
 * satisfies either finding, so exporting a forgotten type from a non-authoring
 * subpath — progress — does not fail as a "new" unowned one.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  capabilityId,
  readManifest,
  readUnownedSurface,
  rel,
  writeUnownedSurface,
} from "./_api-contracts-tree.mjs";
import { collectExports, compareNames, typedEntryPoints } from "./_api-surface.mjs";

/** Every name ANY published subpath of the package exports, from the committed reports. */
function publishedNames(pkg) {
  const names = new Set();
  const manifest = readManifest(join(pkg.dir, "package.json"));
  for (const { slug } of typedEntryPoints(manifest)) {
    const path = join(pkg.dir, "etc", `${slug}.api.md`);
    if (!existsSync(path)) continue;
    for (const entry of collectExports(readFileSync(path, "utf8"), rel(path))) {
      names.add(entry.name);
    }
  }
  return names;
}

/**
 * `{ unowned, forgotten }`, each a map from a name to the capabilities that
 * reach it, over one package's freshly generated reports.
 */
export function ownershipFindings(pkg, reports) {
  return classifyOwnerless(reports, publishedNames(pkg));
}

/**
 * The pure half of {@link ownershipFindings}: every ownerless name a report
 * reaches (`report.unowned`, from `analyzeBody`), split by whether ANY
 * published subpath exports it.
 */
export function classifyOwnerless(reports, published) {
  const unowned = new Map();
  const forgotten = new Map();
  for (const [capability, report] of reports) {
    for (const name of report.unowned) {
      const target = published.has(name) ? unowned : forgotten;
      if (!target.has(name)) target.set(name, []);
      target.get(name).push(capability);
    }
  }
  return { unowned, forgotten };
}

const COMMENT =
  "Declarations a capability hash covers that NO capability owns. `unowned`: exported by a " +
  "published subpath but selected by no capability. `forgotten`: exported by no published " +
  "subpath (ae-forgotten-export). Ratchet: may shrink, never grow. See " +
  "scripts/_api-contracts-ownership.mjs.";

const sorted = (names) => [...names].sort(compareNames);

/** The findings as a baseline file — what `--init` seeds for a new package. */
export function ownershipSnapshot({ unowned, forgotten }) {
  return { comment: COMMENT, unowned: sorted(unowned.keys()), forgotten: sorted(forgotten.keys()) };
}

/**
 * Findings against a baseline: the names it does not allow (with who reaches
 * them), and the baselined names no longer ownerless. A name in EITHER list
 * allows either finding.
 */
export function againstBaseline(findings, baseline) {
  const allowed = new Set([...(baseline.unowned ?? []), ...(baseline.forgotten ?? [])]);
  const pick = (map) => [...map].filter(([name]) => !allowed.has(name));
  const live = new Set([...findings.unowned.keys(), ...findings.forgotten.keys()]);
  return {
    unowned: pick(findings.unowned),
    forgotten: pick(findings.forgotten),
    stale: sorted([...allowed].filter((name) => !live.has(name))),
  };
}

/** The baseline lowered to what is still ownerless. Never adds a name. */
export function loweredBaseline(findings, baseline) {
  const live = new Set([...findings.unowned.keys(), ...findings.forgotten.keys()]);
  return {
    comment: COMMENT,
    unowned: sorted((baseline.unowned ?? []).filter((name) => live.has(name))),
    forgotten: sorted((baseline.forgotten ?? []).filter((name) => live.has(name))),
  };
}

const unbaselined = (pkg, findings) => againstBaseline(findings, readUnownedSurface(pkg));

const describe = (pkg, entries) =>
  entries
    .map(
      ([name, caps]) => `${name} (reached by ${caps.map((c) => capabilityId(pkg, c)).join(", ")})`,
    )
    .join("\n  ");

/** The check: new ownerless names fail; baselined names that are gone warn. */
export function checkOwnership(pkg, findings) {
  const issues = [];
  const warnings = [];
  const { unowned, forgotten, stale } = unbaselined(pkg, findings);
  if (unowned.length > 0) {
    issues.push(
      `${unowned.length} declaration(s) hashed by a ${pkg.name} capability are owned by NO ` +
        `capability:\n  ${describe(pkg, unowned)}\n` +
        "  Each is exported by a published subpath, so its body is hashed in every capability " +
        "that reaches it — one change, several epochs. Give it exactly one owner: select it in " +
        `the ${rel(pkg.entrypointRoot)}/ file it belongs to (re-exporting it from an authoring ` +
        "subpath if it is only on a non-authoring one). This list only shrinks.",
    );
  }
  if (forgotten.length > 0) {
    issues.push(
      `${forgotten.length} declaration(s) hashed by a ${pkg.name} capability are exported by NO ` +
        `published subpath (ae-forgotten-export):\n  ${describe(pkg, forgotten)}\n` +
        "  A consumer has to satisfy the shape and cannot import its name. Export it and select " +
        "it in the capability that owns it. This list only shrinks.",
    );
  }
  if (stale.length > 0) {
    warnings.push(
      `${stale.length} baselined ownerless declaration(s) of ${pkg.name} now have an owner or are ` +
        "gone. Give the headroom back with `node scripts/api-contracts.mjs --update-internal`:\n  " +
        stale.join(", "),
    );
  }
  return { issues, warnings };
}

/**
 * Why `--bump`/`--update` must refuse one capability right now, or `[]`.
 *
 * Only the capability's OWN unbaselined findings block it: a sibling's are that
 * sibling's to fix, and blocking everything on one package-wide finding would
 * turn a local classification into a hostage.
 */
export function ownershipBlockers(pkg, findings, capability) {
  return blockersFor(findings, readUnownedSurface(pkg), capability);
}

/** The pure half of {@link ownershipBlockers}. */
export function blockersFor(findings, baseline, capability) {
  const { unowned, forgotten } = againstBaseline(findings, baseline);
  return [...unowned, ...forgotten]
    .filter(([, caps]) => caps.includes(capability))
    .map(([name]) => name)
    .sort(compareNames);
}

/** `--update-internal`: drop every baselined name that is no longer ownerless. Never adds. */
export function lowerOwnershipBaseline(pkg, findings) {
  writeUnownedSurface(pkg, loweredBaseline(findings, readUnownedSurface(pkg)));
}

/** `--init` on a package that has no baseline yet: record what is there. */
export function seedOwnershipBaseline(pkg, findings) {
  if (existsSync(pkg.unownedSurfacePath)) return;
  writeUnownedSurface(pkg, ownershipSnapshot(findings));
}
