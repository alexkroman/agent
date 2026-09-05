// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Template coverage ratchet for the agent-facing public API.
 *
 * The templates are the reference consumers of the SDK: every export a
 * template exercises is demonstrably useful, documented by example, and
 * protected against accidental breakage by the template tests. This suite
 * statically diffs the public export surface of `@alexkroman1/aai` (the
 * agent-authoring subpaths) and `@alexkroman1/aai-ui` against everything
 * `templates/` actually imports, and holds the gap in
 * `template-api-allowlist.json` — a baseline that may only shrink:
 *
 * - A NEW public export that no template exercises fails the suite. Either
 *   add/extend a template that uses it, or consciously record it in the
 *   allowlist, with review.
 * - A stale allowlist entry (the export gained template coverage, was
 *   renamed, or was removed) also fails, so the baseline ratchets down.
 *
 * There is deliberately no `--update`: an addition should be a hand edit in a
 * reviewable diff. A wholesale regeneration (a scope change, as when this
 * derived its module list) is a throwaway script reusing the functions below —
 * run `biome check --write` on the result, because `JSON.stringify(x, null, 2)`
 * always expands an array where Biome collapses a short one, so raw output
 * fails `pnpm lint` the moment it is written.
 *
 * **An entry here is not an accusation, and this doc used to say it was** —
 * "an export nothing exercises is either missing its example or shouldn't be
 * public". That framing was audited against the whole `@alexkroman1/aai` root
 * barrel and did not survive. Of its sixty unexercised names, twenty-six are
 * deliberate re-exports of a narrower subpath, each with a written argument in
 * `index.ts` for why the root carries it too (four import lines to annotate a
 * stage; a preset whose absence made the wrong mode the easy one; types that
 * were FORGOTTEN exports an author could not name); thirty-two more are
 * annotation-only types that templates get by inference and never spell; and
 * the last two are documented values. Nothing on that barrel should come out,
 * and the audit's product was that sentence rather than a deletion.
 *
 * So there is a third case the dichotomy had no room for: an export whose
 * reader ANNOTATES with it rather than calling it. That is why the entries are
 * a plain list and carry no verdict — the file records what is unexercised,
 * and what to do about any given name is a judgement made against the code.
 * The audit did find real removals, but in `@alexkroman1/aai-ui`: four tuning
 * constants referenced by no public signature and named by no file outside
 * that package, which moved to its `/internal` subpath and cost two epochs.
 *
 * Knip can't express this check: it counts *any* usage — and nearly every
 * SDK export is used internally by the host/server packages — whereas this
 * asks specifically "does a template exercise it?". Analysis is purely
 * static (oxc-parser module records), so no SDK code is executed and
 * type-only exports are covered too.
 *
 * Scope is DERIVED, from `exampleFacingSubpaths()` in
 * `scripts/_api-contracts-tree.mjs` — the same function that decides what
 * `pnpm check:api-contracts` versions, minus a written deny-list. It used to be
 * a hand-kept map of seven module specifiers in this file, and that map was the
 * repo's third definition of "the authoring surface": the contract system said
 * fifteen `aai` subpaths, the shipped guide documented about seven, and this
 * said `aai` root plus four provider subpaths. They disagreed in both
 * directions and nothing could see it. `/utils` was called "host-side, their
 * consumers are the CLI and the platform, not agents" here while its own
 * capability contract called it "the zero-dependency helpers a TOOL body may
 * reach for" and the templates imported it twenty-six times; `/ffmpeg` was
 * absent for as long as it had been a contracted capability.
 *
 * Derivation is also what stops the next one: a new authoring subpath joins
 * this ratchet the moment it is published, and taking one OUT costs an entry
 * with a reason in the deny-list rather than a silent omission here.
 *
 * The corpus is both halves of what ships to a user as an example — the
 * templates AND the scaffold, whose `server.mjs` is the only thing that
 * exercises `@alexkroman1/aai-ui/client-dir`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, test } from "vitest";
import { byCodeUnit, sole } from "./_template-support.ts";

/** The PACKAGE root: `templates/` and the allowlist sit beside `src/`. */
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = path.resolve(HERE, "..");
const TEMPLATES_DIR = path.join(HERE, "templates");
const SCAFFOLD_DIR = path.join(HERE, "scaffold");
const ALLOWLIST_PATH = path.join(HERE, "template-api-allowlist.json");

/**
 * The contract tree's own view of the surface, imported rather than restated.
 *
 * `import.meta.glob` is the idiom every gate-under-a-gate suite here uses to
 * reach a `scripts/` module; it is compiled away by Vite, so the options must
 * be a literal at the call site.
 */
type ContractsTree = {
  contractPackages: () => { key: string; name: string }[];
  exampleFacingSubpaths: (pkg: { key: string; name: string }) => Record<string, string>;
};

const contractsTree = sole(
  import.meta.glob<ContractsTree>("../../../scripts/_api-contracts-tree.mjs", { eager: true }),
);
if (!contractsTree) throw new Error("scripts/_api-contracts-tree.mjs did not load");

/** Module specifier → sibling package dir + package.json exports subpath. */
const SCOPED_MODULES: Record<string, { pkg: string; subpath: string }> = Object.fromEntries(
  contractsTree
    .contractPackages()
    .flatMap((pkg) =>
      Object.entries(contractsTree.exampleFacingSubpaths(pkg)).map(([spec, subpath]) => [
        spec,
        { pkg: pkg.key, subpath },
      ]),
    ),
);

type ModuleRecord = ReturnType<typeof parseSync>["module"];

function parseModule(file: string): ModuleRecord {
  const result = parseSync(file, readFileSync(file, "utf8"));
  const fatal = result.errors.filter((e) => e.severity === "Error");
  if (fatal.length > 0) {
    throw new Error(`Parse errors in ${file}: ${fatal.map((e) => e.message).join("; ")}`);
  }
  return result.module;
}

/** Resolve the `@dev/source` entry file for a package.json exports subpath. */
function entryFileFor(spec: string): string {
  const scoped = SCOPED_MODULES[spec];
  if (!scoped) throw new Error(`Unknown scoped module: ${spec}`);
  const { pkg, subpath } = scoped;
  const pkgDir = path.join(PACKAGES_DIR, pkg);
  const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
    exports?: Record<string, Record<string, string> | string>;
  };
  const entry = manifest.exports?.[subpath];
  const source = typeof entry === "object" ? entry["@dev/source"] : undefined;
  if (!source) throw new Error(`${pkg} package.json exports["${subpath}"] has no @dev/source`);
  return path.join(pkgDir, source);
}

/** Resolve a relative re-export specifier the way the bundlers do. */
function resolveRelative(fromFile: string, spec: string): string {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`Cannot resolve re-export "${spec}" from ${fromFile}`);
}

/**
 * All export names reachable from an entry file, following relative
 * `export * from` chains (the barrel style the SDK uses). Named re-exports
 * carry their name inline, so only star re-exports recurse.
 */
function collectExports(file: string, seen = new Set<string>()): Set<string> {
  const names = new Set<string>();
  if (seen.has(file)) return names;
  seen.add(file);
  const entries = parseModule(file).staticExports.flatMap((statement) => statement.entries);
  for (const entry of entries) {
    if (entry.exportName.kind === "Name" && entry.exportName.name) {
      names.add(entry.exportName.name);
    } else if (entry.exportName.kind === "Default") {
      names.add("default");
    } else if (entry.importName.kind === "AllButDefault" && entry.moduleRequest) {
      const target = resolveRelative(file, entry.moduleRequest.value);
      for (const name of collectExports(target, seen)) names.add(name);
    }
  }
  return names;
}

/**
 * Every source file in one shipped-example tree.
 *
 * `.mjs` is included for the scaffold's `server.mjs`, which is real shipped
 * code an author runs and the only exerciser of
 * `@alexkroman1/aai-ui/client-dir`.
 */
function walkExampleSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__snapshots__" || name === "node_modules") continue;
    const filePath = path.join(dir, name);
    if (statSync(filePath).isDirectory()) walkExampleSources(filePath, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(filePath);
  }
  return out;
}

/** Both halves of what ships to a user as an example. */
function exampleSources(): string[] {
  return [...walkExampleSources(TEMPLATES_DIR), ...walkExampleSources(SCAFFOLD_DIR)];
}

/**
 * Every name the templates import (or re-export) from each scoped module.
 * A namespace import (`import * as`) marks the whole module exercised via
 * the `"*"` sentinel — there is no per-name signal to extract from it.
 */
function collectTemplateUsage(): Map<string, Set<string>> {
  const used = new Map(Object.keys(SCOPED_MODULES).map((spec) => [spec, new Set<string>()]));
  const record = (spec: string, importName: { kind: string; name: string | null }): undefined => {
    const bucket = used.get(spec);
    if (!bucket) return;
    if (importName.kind === "Name" && importName.name) bucket.add(importName.name);
    else if (importName.kind === "Default") bucket.add("default");
    else if (importName.kind === "NamespaceObject" || importName.kind === "All") bucket.add("*");
  };
  for (const file of exampleSources()) {
    const mod = parseModule(file);
    for (const imp of mod.staticImports) {
      for (const entry of imp.entries) record(imp.moduleRequest.value, entry.importName);
    }
    for (const statement of mod.staticExports) {
      for (const entry of statement.entries) {
        if (entry.moduleRequest) record(entry.moduleRequest.value, entry.importName);
      }
    }
  }
  return used;
}

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as Record<string, string[]>;
const usage = collectTemplateUsage();
const specs = Object.keys(SCOPED_MODULES);

describe("template API coverage ratchet", () => {
  test("templates import from the scoped packages at all", () => {
    // Sanity guard: if the parser or the walker regresses to finding
    // nothing, every per-module assertion below would pass vacuously.
    const totalUsed = specs.reduce((sum, spec) => sum + (usage.get(spec)?.size ?? 0), 0);
    expect(totalUsed).toBeGreaterThan(0);
  });

  test("allowlist keys match the scoped module list", () => {
    expect(Object.keys(allowlist).sort()).toEqual([...specs].sort());
  });

  test.each(specs)("%s: unexercised exports match the allowlist", (spec) => {
    const exported = collectExports(entryFileFor(spec));
    expect(exported.size).toBeGreaterThan(0);

    const used = usage.get(spec) ?? new Set<string>();
    const unexercised = used.has("*")
      ? []
      : [...exported].filter((name) => !used.has(name)).sort(byCodeUnit);

    const baseline = new Set(allowlist[spec] ?? []);
    const newlyUnexercised = unexercised.filter((name) => !baseline.has(name));
    const stale = [...baseline].filter((name) => !unexercised.includes(name)).sort(byCodeUnit);

    expect(
      newlyUnexercised,
      `Public exports of ${spec} that no template exercises. Add or extend a ` +
        "template that uses them, or record them in template-api-allowlist.json " +
        "if leaving them without an example is a conscious choice.",
    ).toEqual([]);

    expect(
      stale,
      `Stale template-api-allowlist.json entries for ${spec}: each is now ` +
        "exercised by a template, renamed, or no longer exported. Remove them " +
        "so the baseline only ratchets down.",
    ).toEqual([]);
  });
});
