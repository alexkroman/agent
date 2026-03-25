// Copyright 2025 the AAI authors. MIT license.
/**
 * Validates that every published export in package.json has a corresponding
 * source file and that all symbols listed in the api-extractor report are
 * actually exported from the main entry point.
 *
 * This test operates on source files only — dist/ is never read.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PKG_DIR = resolve(import.meta.dirname);
const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, "package.json"), "utf-8"));
const exports: Record<string, Record<string, string> | string> = pkg.exports;

describe("published exports", () => {
  for (const [entrypoint, value] of Object.entries(exports)) {
    if (typeof value === "string") continue; // e.g. CSS files
    const source = value.source;
    if (!source) continue;

    it(`${entrypoint} → ${source} exists and is importable`, async () => {
      const fullPath = resolve(PKG_DIR, source);
      // Verify the source file exists (will throw if not)
      const mod = await import(fullPath);
      expect(mod).toBeDefined();
    });
  }

  it("main entry (.) re-exports all symbols from api-extractor report", async () => {
    const apiReport = readFileSync(resolve(PKG_DIR, "api/aai.api.md"), "utf-8");
    const mod = await import(resolve(PKG_DIR, "index.ts"));

    // Extract exported value names (functions, consts, classes) from the api report.
    // Type-only exports are not visible at runtime and are checked separately.
    const valueExports = new Set<string>();
    for (const match of apiReport.matchAll(/^export (?:function |const |class )(\w+)/gm)) {
      if (match[1]) valueExports.add(match[1]);
    }

    // Extract type-only exports for a count assertion
    const typeExports = new Set<string>();
    for (const match of apiReport.matchAll(/^export type (\w+)/gm)) {
      if (match[1]) typeExports.add(match[1]);
    }

    expect(valueExports.size).toBeGreaterThan(0);
    expect(typeExports.size).toBeGreaterThan(0);

    for (const name of valueExports) {
      expect(mod, `Missing value export: ${name}`).toHaveProperty(name);
    }
  });

  it("every public export entry has a 'source' field pointing to a .ts file", () => {
    for (const [entrypoint, value] of Object.entries(exports)) {
      if (typeof value === "string") continue;
      expect(value.source, `${entrypoint} missing 'source' field`).toBeDefined();
      expect(value.source, `${entrypoint} source should be .ts`).toMatch(/\.ts$/);
    }
  });

  it("every public export entry has a 'types' field pointing to dist/", () => {
    for (const [entrypoint, value] of Object.entries(exports)) {
      if (typeof value === "string") continue;
      expect(value.types, `${entrypoint} missing 'types' field`).toBeDefined();
      expect(value.types, `${entrypoint} types should be in dist/`).toMatch(/^\.\/dist\//);
    }
  });
});
