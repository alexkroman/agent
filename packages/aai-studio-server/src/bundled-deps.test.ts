// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai-server` must be COMPILED IN to the service entry, and the failure mode
 * when it isn't is silent: the build succeeds, the entry runs, and the only
 * symptom is a slower container cold start (see tsdown.config.ts for the
 * reasoning). It stayed broken for a long time because the pattern was
 * `/^aai-server$/` while every import is a SUBPATH — `alwaysBundle` matches
 * the specifier, not the package.
 *
 * So the guard is a pattern-vs-specifier check rather than an assertion about
 * the built file: `dist/` is not a test input (the `test` turbo task depends
 * on `^build`, its dependencies' builds, not its own), and a test that
 * silently skipped when it was missing would be no guard at all.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import manifest from "../package.json" with { type: "json" };
import { BUNDLED_WORKSPACE_DEPS } from "../tsdown.config.ts";

const PACKAGE_DIR = import.meta.dirname;
const SERVER_SRC = path.join(PACKAGE_DIR, "..", "..", "aai-server", "src");

/** Every `aai-server/...` specifier this package's shipped source imports. */
function serverSpecifiers(): string[] {
  const found = new Set<string>();
  for (const name of readdirSync(PACKAGE_DIR)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.startsWith("_")) continue;
    const source = readFileSync(path.join(PACKAGE_DIR, name), "utf-8");
    for (const m of source.matchAll(/from "(aai-server(?:\/[^"]*)?)"/g)) found.add(m[1] as string);
  }
  return [...found].sort();
}

describe("bundled workspace deps", () => {
  test("cover every aai-server specifier the entry imports", () => {
    const specifiers = serverSpecifiers();
    // Without this, an empty scan (a moved file, a changed import style) would
    // make the loop below vacuous and the test green on a broken config.
    expect(specifiers.length).toBeGreaterThan(5);
    for (const specifier of specifiers) {
      expect
        .soft(
          BUNDLED_WORKSPACE_DEPS.some((pattern) => pattern.test(specifier)),
          `${specifier} is not matched by any alwaysBundle pattern — it would stay external`,
        )
        .toBe(true);
    }
  });

  // The exact regression this file exists for: the bare-name pattern matches
  // the package but none of the specifiers, so it reads as correct and bundles
  // nothing.
  test("are not satisfied by a bare package-name pattern", () => {
    expect(serverSpecifiers().some((specifier) => /^aai-server$/.test(specifier))).toBe(false);
  });

  // `@alexkroman1/aai` ships compiled `dist` JS and stays external on purpose;
  // bundling it would pull a published package's provider graph into the entry.
  test("leave the published SDK external", () => {
    expect(BUNDLED_WORKSPACE_DEPS.some((p) => p.test("@alexkroman1/aai"))).toBe(false);
    expect(BUNDLED_WORKSPACE_DEPS.some((p) => p.test("@alexkroman1/aai/protocol"))).toBe(false);
  });
});

/**
 * Every workspace package `aai-server` imports must be declared HERE too, so
 * bundling that package in never MOVES a sibling's modules.
 *
 * `aai-server` is compiled into this entry (above), and tsdown externalizes
 * only what this manifest declares — so a sibling `aai-server` imports and
 * this package does not is inlined at `dist/index.mjs`. That relocation is
 * silent to the build and to the type checker, and it breaks any module that
 * resolves something by its own location: `import.meta.url` becomes the
 * BUNDLE's path, whose pnpm `node_modules` holds only what is declared here.
 *
 * It shipped. `@alexkroman1/aai-ui` was undeclared, so `client-dir.ts` — whose
 * `defaultClientDir()` finds the prebuilt browser client by self-referencing
 * `@alexkroman1/aai-ui/package.json`, legal from inside that package and
 * nowhere else — was inlined here, and every deployed agent page answered 500
 * with "Could not locate the default client UI — is @alexkroman1/aai-ui
 * installed?" on a platform where it plainly was. Declared, the specifier
 * stays external and the function runs inside its own package again.
 *
 * The check is on the IMPORT, not on the `require.resolve`: the resolution
 * that broke lives in aai-ui, three modules from anything aai-server wrote, so
 * a scan for resolve calls in the bundled source would have seen nothing. What
 * is knowable here is which packages the bundle swallows.
 *
 * This package's own guide states the mirror rule — "anything else that resolves a
 * workspace sibling by module location owes the same fallback" (the shape
 * `guestPackageDir` carries for `aai-guest`, which is RESOLVED but never
 * imported, so it does not appear here): keeping the package external is the
 * fix when the sibling is imported, and a fallback is the fix when it is only
 * ever resolved.
 */
describe("workspace siblings of the bundled server", () => {
  /** Every workspace package `aai-server`'s source imports by name. */
  function serverWorkspaceImports(): string[] {
    const found = new Set<string>();
    for (const name of readdirSync(SERVER_SRC)) {
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(path.join(SERVER_SRC, name), "utf-8");
      // The character class excludes `/`, so a subpath specifier
      // (`@alexkroman1/aai-ui/client-dir`, `aai-server/orchestrator`) yields
      // the PACKAGE — which is the granularity externality is decided at.
      for (const m of source.matchAll(/from "(@alexkroman1\/[\w.-]+|aai-[\w.-]+)/g)) {
        found.add(m[1] as string);
      }
    }
    // Compiled in on purpose, and the whole reason this check exists.
    found.delete("aai-server");
    return [...found].sort();
  }

  test("are declared here, so they stay external", () => {
    const imports = serverWorkspaceImports();
    // A scan that matched nothing would make the loop below vacuous — the same
    // trap the aai-server specifier check above guards against.
    expect(imports.length).toBeGreaterThan(2);
    const declared = Object.keys(manifest.dependencies);
    for (const name of imports) {
      expect
        .soft(
          declared.includes(name),
          `aai-server imports ${name}, which this package does not declare — it would be ` +
            "INLINED into dist/index.mjs, moving its modules out of their own package",
        )
        .toBe(true);
    }
  });

  // The regression itself: the package whose self-reference the bundle broke.
  test("include the default client's package", () => {
    expect(serverWorkspaceImports()).toContain("@alexkroman1/aai-ui");
    expect(Object.keys(manifest.dependencies)).toContain("@alexkroman1/aai-ui");
  });
});
