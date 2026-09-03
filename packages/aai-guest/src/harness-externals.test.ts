// Copyright 2026 the AAI authors. MIT license.
/**
 * A package excluded from the harness bundle must be INSTALLED beside it.
 *
 * `tsdown.config.ts` bundles everything except a `neverBundle` list, and the
 * harness ships as one file into a snapshot image — so every entry on that list
 * becomes a runtime resolution against the `node_modules` next to the harness
 * (`/opt/aai` in the baked image, this package's own in dev). Two halves have to
 * agree for that to work, and nothing checked either:
 *
 * 1. The specifier is really EXTERNAL in the built artifact.
 * 2. Something installs it beside the harness — the locked guest toolchain
 *    (`toolchain/package.json`), or `modal-harness-image.ts`'s separate
 *    `@alexkroman1/*` install.
 *
 * **The case that made this file necessary is gone, and it is worth keeping the
 * reason.** `@workflow/world-postgres` was on neither side of the rule: bundled,
 * while its Drizzle migrator reads `drizzle/migrations/meta/_journal.json` off
 * disk relative to its own module location — which a bundle does not carry. A
 * guest holding a `DATABASE_URL` died on `Can't find meta/_journal.json` before
 * running a single migration. It went unnoticed for as long as it did because
 * the prerequisite — an agent with storage enabled — had never been met
 * anywhere, so the whole feature was dark.
 *
 * That package left with the Workflow DevKit, so its three cases went too. The
 * RULE outlives it and is what the remaining cases hold: the next entry added to
 * `neverBundle` for a package that reads its own files off disk has the identical
 * failure waiting for it.
 *
 * These run in the UNIT tier deliberately: they are filesystem READS (legal
 * here) over the real built artifact and the committed manifests, so they cost
 * milliseconds and fail in the ordinary `pnpm test`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import config from "../tsdown.config.ts";

/** The PACKAGE root: `dist/` and `toolchain/` both sit beside `src/`. */
const PKG = join(import.meta.dirname, "..");
const HARNESS = join(PKG, "dist/harness.mjs");

/** The `neverBundle` patterns, as the source strings they match. */
const NEVER_BUNDLE = ["@alexkroman1/aai-cli", "@vitejs/plugin-react", "@tailwindcss/vite"] as const;

/**
 * The declared list, read off the real config rather than re-typed.
 *
 * A hand-copied list is the failure this whole file is about, one level up: it
 * would keep passing while the config changed underneath it.
 */
function declaredPatterns(): RegExp[] {
  const deps = config.deps;
  if (!deps || Array.isArray(deps) || !("neverBundle" in deps)) {
    throw new Error("tsdown.config.ts declares no deps.neverBundle");
  }
  const patterns = deps.neverBundle;
  if (!Array.isArray(patterns)) throw new Error("neverBundle is not a list");
  return patterns.filter((p): p is RegExp => p instanceof RegExp);
}

describe("the neverBundle list", () => {
  test("is exactly the set this file reasons about", () => {
    // A FLOOR on the corpus, in the shape the repo's ratchets use: an entry
    // added without a matching case below would otherwise be checked by nothing,
    // and the whole point here is that an un-installed external is unshippable.
    const patterns = declaredPatterns();
    expect(patterns).toHaveLength(NEVER_BUNDLE.length);
    for (const specifier of NEVER_BUNDLE) {
      expect(
        patterns.some((p) => p.test(specifier)),
        `no neverBundle pattern matches ${specifier}`,
      ).toBe(true);
    }
  });

  test("every entry is INSTALLED beside the harness, or is an SDK package", () => {
    // The invariant, and the one that generalizes past today's bug: excluding a
    // package from the bundle without installing it beside the harness produces a
    // guest that boots and then cannot resolve it — at the first session, or (as
    // here) at the first workflow. `@alexkroman1/*` is the documented exception:
    // its versions change per release, so modal-harness-image.ts installs those
    // separately at exact resolved versions.
    const toolchain = JSON.parse(readFileSync(join(PKG, "toolchain/package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    const installed = new Set(Object.keys(toolchain.dependencies ?? {}));
    const missing = NEVER_BUNDLE.filter(
      (name) => !(name.startsWith("@alexkroman1/") || installed.has(name)),
    );
    expect(missing, "neverBundle entries absent from the locked guest toolchain").toEqual([]);
  });
});

describe("the built harness", () => {
  // Read UNCONDITIONALLY. `aai-guest#test` declares its own `build`
  // (turbo.json), so the artifact is there by construction — and a suite that
  // skipped itself without one would be the silent skip this whole file exists
  // to prevent: the check between a shipped guest and a package it can no
  // longer resolve, quietly not running. A missing file fails loudly here.
  const bundle = readFileSync(HARNESS, "utf-8");

  test("keeps the build toolchain external", () => {
    // Asserted on the ARTIFACT rather than on `tsdown.config.ts` alone, which is
    // the distinction that matters: a config assertion passes on a build that
    // never ran. Bundling rolldown's native binaries would break the harness in
    // a way no unit test would see.
    for (const specifier of ["@vitejs/plugin-react", "@tailwindcss/vite"]) {
      expect(bundle, `${specifier} looks inlined`).toContain(specifier);
    }
  });
});
