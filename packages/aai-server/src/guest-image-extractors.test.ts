// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The guest image's build inputs still resolve out of the modules that declare
 * them.
 *
 * `scripts/build-guest-image.mjs` and `scripts/ensure-guest-image.mjs` are plain
 * `.mjs` run by node with no loader, so they cannot import a TypeScript
 * constant — they read it back out of the SOURCE with a regex
 * (`build-guest-image-extract.mjs`). That reader sees a `const`, and nothing
 * else. TypeScript, meanwhile, follows a re-export. So a constant can move to
 * another module, leave a re-export behind, and every import site plus every
 * spec keeps resolving it while the image build stops resolving it entirely.
 *
 * That is not hypothetical — it is why this file exists. `GUEST_ROOT` moved from
 * `modal-harness-image.ts` to `guest-exec-env.ts`, the old module re-exported it
 * by name, and the whole test suite stayed green; the failure surfaced as
 * `pnpm dev:aai-server` dying in `predev`. `guest-image-dockerfile.test.ts` did
 * not catch it and structurally could not: it compares the Dockerfile's
 * committed ARG defaults against the constants, and never calls an extractor.
 * (`build-guest-image.mjs`'s module doc credited it with this job anyway, which
 * is the worst shape available here — a doc asserting a protection nothing held.)
 *
 * So the assertion is the one only a test can make: resolve every entry of
 * `GUEST_IMAGE_CONSTANTS` through the real extractor and compare it to the
 * constant IMPORTED from TypeScript. Moving any of the four now fails HERE.
 *
 * The extractor module is imported for real rather than read as text — it is
 * pure (two regex readers and a table, no side effects), which is what makes
 * that safe, and a text assertion would only re-implement the thing under test.
 * A filesystem read is unit-legal, so this runs in the ordinary test run.
 */

import { describe, expect, test } from "vitest";
import { GUEST_ROOT } from "./guest-exec-env.ts";
import { DEFAULT_SANDBOX_IMAGE } from "./modal-context.ts";
import { SDK_PACKAGES } from "./modal-harness-image.ts";
import { GUEST_SYSTEM_PACKAGES } from "./modal-system-packages.ts";

/** A `GUEST_IMAGE_CONSTANTS` entry: which module declares it, and its shape. */
type InputEntry = { module: string; kind: "string" | "array" };

/**
 * The one value a single-file glob resolved to.
 *
 * `import.meta.glob` is a compile-time transform, so its pattern must be a
 * literal at the call site and the result is a one-entry record keyed by that
 * same literal. Taking `Object.values()[0]` names the path once instead of
 * twice; `| undefined` is deliberate, so a pattern that stopped resolving fails
 * the assertions below rather than passing as an empty table.
 */
const sole = <T>(module: Record<string, T>): T | undefined => Object.values(module)[0];

const table = sole(
  import.meta.glob<Record<string, InputEntry>>("../../../scripts/build-guest-image-extract.mjs", {
    import: "GUEST_IMAGE_CONSTANTS",
    eager: true,
  }),
);

const resolve = sole(
  import.meta.glob<(name: string) => string | string[]>(
    "../../../scripts/build-guest-image-extract.mjs",
    { import: "guestImageConstant", eager: true },
  ),
);

const builderDoc = sole(
  import.meta.glob<string>("../../../scripts/build-guest-image.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/**
 * Every constant a guest image is built from, paired with the value TypeScript
 * resolves for it.
 *
 * Hand-written on purpose: deriving the expectation from the same table under
 * test would assert only that the extractor agrees with itself. This is the
 * independent side, and adding a build input means adding a row.
 */
const EXPECTED: Record<string, string | readonly string[]> = {
  DEFAULT_SANDBOX_IMAGE,
  GUEST_ROOT,
  GUEST_SYSTEM_PACKAGES,
  SDK_PACKAGES,
};

describe("the guest image's build inputs are readable by the build scripts", () => {
  test("the extractor table and this spec cover the same constants", () => {
    // A new build input defaults INTO being checked, and neither side can lose
    // an entry quietly: the whole output of the loop below is "n passed".
    expect(table).toBeTypeOf("object");
    expect(Object.keys(table ?? {}).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(EXPECTED)).toHaveLength(4);
  });

  test.each(Object.keys(EXPECTED))(
    "%s resolves to the value TypeScript declares",
    (name: string) => {
      // The assertion the extractor cannot make about itself. A regex read sees
      // a `const` and never a re-export, so a constant that MOVED throws here
      // (naming the module the table still points at) and a constant whose value
      // changed shape fails the comparison.
      const expected = EXPECTED[name];
      const actual = resolve?.(name);
      if (Array.isArray(expected)) expect(actual).toEqual([...expected]);
      else expect(actual).toBe(expected);
    },
  );

  test("every entry names a module that really DECLARES its constant", () => {
    // Not merely one that re-exports it. `guestImageConstant` throwing is what
    // enforces this; asserting it does not throw is the point of the loop above,
    // and this pins the table's shape so an entry cannot go half-written.
    for (const [name, entry] of Object.entries(table ?? {})) {
      expect(entry.module, name).toMatch(/^[a-z0-9-]+\.ts$/);
      expect(["string", "array"], name).toContain(entry.kind);
    }
    expect(Object.keys(table ?? {}).length).toBeGreaterThanOrEqual(4);
  });

  test("the builder's ARG->Source doc table names the same modules", () => {
    // The stale half of the original failure: the prose table said
    // `GUEST_ROOT (modal-harness-image.ts)` for as long as the build was broken.
    // A doc is the copy that rots, so it is asserted rather than trusted.
    expect(builderDoc).toBeTypeOf("string");
    for (const [name, entry] of Object.entries(table ?? {})) {
      expect(builderDoc, name).toContain(`\`${name}\` (${entry.module})`);
    }
  });

  test("no script anywhere reads a constant without going through the table", () => {
    // This is what closes the CLASS rather than the four instances. The location
    // of each constant lives in ONE place; a call site that rebuilt a
    // `packages/aai-server/<module>.ts` path and called the raw reader would be a
    // second place to update, which is exactly the spread that made the move
    // expensive — the same path was spelled at five sites across three scripts.
    //
    // Scoped to all of `scripts/`, not to today's three consumers, so a NEW
    // script (or a new extraction in an existing one) cannot reintroduce the
    // failure by being written after this spec. The extract module is the sole
    // exemption: it DEFINES the readers, and the table is how it calls them.
    const scripts = import.meta.glob<string>("../../../scripts/**/*.mjs", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    // Floor: a glob that stopped resolving would pass this loop vacuously, which
    // is the same shape of dead gate as the doc claim that started all this.
    expect(Object.keys(scripts).length).toBeGreaterThan(30);
    const offenders = Object.entries(scripts)
      .filter(([file]) => !file.endsWith("/build-guest-image-extract.mjs"))
      .filter(([, source]) => /\bextractString(Array)?\s*\(/.test(source))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
