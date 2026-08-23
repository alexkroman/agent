// Copyright 2026 the AAI authors. MIT license.
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
 *   allowlist (with review — an export nothing exercises is either missing
 *   its example or shouldn't be public).
 * - A stale allowlist entry (the export gained template coverage, was
 *   renamed, or was removed) also fails, so the baseline ratchets down.
 *
 * Knip can't express this check: it counts *any* usage — and nearly every
 * SDK export is used internally by the host/server packages — whereas this
 * asks specifically "does a template exercise it?". Analysis is purely
 * static (oxc-parser module records), so no SDK code is executed and
 * type-only exports are covered too.
 *
 * Scope is the agent-authoring surface a template can legitimately import:
 * `@alexkroman1/aai` root plus the `stt`/`tts`/`llm`/`s2s`/`ffmpeg`
 * subpaths, and the `@alexkroman1/aai-ui` root. Host-side subpaths
 * (`runtime`, `manifest`, `protocol`, `utils`) are deliberately out of
 * scope — their consumers are the CLI and the platform, not agents.
 *
 * `/ffmpeg` was ABSENT from this list for as long as it has been a contracted
 * capability, so it was the one authoring stage subpath this ratchet could not
 * see — three templates import from it and none of its exports was ever
 * counted.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, test } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.resolve(HERE, "..");
const TEMPLATES_DIR = path.join(HERE, "templates");
const ALLOWLIST_PATH = path.join(HERE, "template-api-allowlist.json");

/** Module specifier → sibling package dir + package.json exports subpath. */
const SCOPED_MODULES: Record<string, { pkg: string; subpath: string }> = {
  "@alexkroman1/aai": { pkg: "aai", subpath: "." },
  "@alexkroman1/aai/stt": { pkg: "aai", subpath: "./stt" },
  "@alexkroman1/aai/tts": { pkg: "aai", subpath: "./tts" },
  "@alexkroman1/aai/llm": { pkg: "aai", subpath: "./llm" },
  "@alexkroman1/aai/s2s": { pkg: "aai", subpath: "./s2s" },
  "@alexkroman1/aai/ffmpeg": { pkg: "aai", subpath: "./ffmpeg" },
  "@alexkroman1/aai-ui": { pkg: "aai-ui", subpath: "." },
};

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

function walkTemplateSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__snapshots__" || name === "node_modules") continue;
    const filePath = path.join(dir, name);
    if (statSync(filePath).isDirectory()) walkTemplateSources(filePath, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(filePath);
  }
  return out;
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
  for (const file of walkTemplateSources(TEMPLATES_DIR)) {
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
      : [...exported].filter((name) => !used.has(name)).sort((a, b) => a.localeCompare(b));

    const baseline = new Set(allowlist[spec] ?? []);
    const newlyUnexercised = unexercised.filter((name) => !baseline.has(name));
    const stale = [...baseline]
      .filter((name) => !unexercised.includes(name))
      .sort((a, b) => a.localeCompare(b));

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
