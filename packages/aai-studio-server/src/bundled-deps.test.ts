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
import { BUNDLED_WORKSPACE_DEPS } from "../tsdown.config.ts";

const PACKAGE_DIR = import.meta.dirname;

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
