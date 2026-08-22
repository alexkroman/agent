// Copyright 2026 the AAI authors. MIT license.
/**
 * The one rule this module exists to hold: **the DevKit is never handed a bare
 * specifier.**
 *
 * What these can and cannot check is worth stating, because it decided their
 * shape. Vitest patches `createRequire`, so a bare specifier RESOLVES from any
 * directory inside this tier — verified, a negative control asserting that
 * `require("@workflow/world-postgres")` fails from `tmpdir()` did not throw. So
 * the real failure is unprovable here (the same trap the guest guide records for
 * `loadTransformer`), and what is provable is the SHAPE of what we pass on:
 * absolute, and of the right kind for the mechanism that will load it. Both
 * assertions fail when the resolution is removed — checked by reverting.
 */

import { isAbsolute } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveImportSpecifier, resolveWorldSpecifier } from "./workflow-resolve.ts";

const WORLD = "@workflow/world-postgres";

describe("resolveWorldSpecifier", () => {
  test("answers an absolute PATH, because the DevKit requires it", () => {
    // `require` takes a path, never a URL — which is why this half does not use
    // `import.meta.resolve`.
    const resolved = resolveWorldSpecifier(WORLD);
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.startsWith("file:")).toBe(false);
    expect(resolved).toContain(WORLD);
  });

  test("leaves an unresolvable specifier ALONE", () => {
    // Returned as it was so the load fails with Node's own "Cannot find module"
    // naming the package. An absolute path that resolves to nothing, or a silent
    // fallback to the local world, would both hide a genuine packaging problem —
    // and the second is the one that ships a Postgres agent onto an unmigrated
    // database.
    expect(resolveWorldSpecifier("@workflow/world-does-not-exist")).toBe(
      "@workflow/world-does-not-exist",
    );
  });
});

describe("resolveImportSpecifier", () => {
  test("answers a file URL, because an import resolves that way", () => {
    const resolved = resolveImportSpecifier(WORLD);
    expect(resolved?.startsWith("file:")).toBe(true);
  });

  test("resolves `workflow` the way an IMPORT does, not the way a require does", () => {
    // The distinction that has already cost a debugging round: `workflow`'s root
    // entry maps `require` to its TypeScript PLUGIN, so resolving this one with
    // `createRequire` rewrote an ESM import to a CJS plugin that then failed
    // loading `typescript/lib/tsserverlibrary`. Asserting the two halves DIFFER
    // here is what keeps them from being collapsed into one helper later.
    const asImport = resolveImportSpecifier("workflow");
    const asRequire = resolveWorldSpecifier("workflow");
    expect(asImport).toBeDefined();
    expect(asImport).not.toBe(asRequire);
  });

  test("reports nothing for an unresolvable specifier", () => {
    // `undefined` rather than the input, because its caller's fallback is to leave
    // the ORIGINAL text in place — a rewriter cannot tell "resolved to itself"
    // from "could not resolve" if both come back as the specifier.
    expect(resolveImportSpecifier("@workflow/world-does-not-exist")).toBeUndefined();
  });
});
