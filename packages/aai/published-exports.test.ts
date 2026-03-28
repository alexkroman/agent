// Copyright 2025 the AAI authors. MIT license.
/**
 * Validates that every published export in package.json has a corresponding
 * source file and that the main entry point exports expected public symbols.
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

  it("main entry (.) exports expected public symbols", async () => {
    const mod = await import(resolve(PKG_DIR, "index.ts"));

    // Value exports (functions, consts) that consumers depend on
    const expectedValues = ["defineAgent", "defineTool", "tool", "createToolFactory"];
    for (const name of expectedValues) {
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
