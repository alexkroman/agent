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
 * **This is the test that was missing when the durable workflow world shipped
 * broken.** `@workflow/world-postgres` was on neither side of that: bundled, and
 * its Drizzle migrator reads `drizzle/migrations/meta/_journal.json` off disk
 * relative to its own module location — which a bundle does not carry. So a guest
 * holding a `DATABASE_URL` died on `Can't find meta/_journal.json` before running
 * a single migration, and the workflow API's own runtime `require` of the package
 * failed from the temp dir it dispatches steps in. It went unnoticed for as long
 * as it did because the prerequisite — an agent with storage enabled — had never
 * been met anywhere, so the whole feature was dark.
 *
 * These run in the UNIT tier deliberately: they are filesystem READS (legal
 * here) over the real built artifact and the committed manifests, so they cost
 * milliseconds and fail in the ordinary `pnpm test`. What they do NOT prove is
 * that a world actually migrates against a real database — that needs the
 * scenario tier and a Postgres, and is noted at the bottom.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import config from "./tsdown.config.ts";

const HERE = import.meta.dirname;
const HARNESS = join(HERE, "dist/harness.mjs");

/** The `neverBundle` patterns, as the source strings they match. */
const NEVER_BUNDLE = [
  "@alexkroman1/aai-cli",
  "@vitejs/plugin-react",
  "@tailwindcss/vite",
  "@workflow/world-postgres",
] as const;

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
    const toolchain = JSON.parse(readFileSync(join(HERE, "toolchain/package.json"), "utf-8")) as {
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
  // to prevent: the check between a shipped guest and a dead workflow world,
  // quietly not running. A missing file fails loudly here instead.
  const bundle = readFileSync(HARNESS, "utf-8");

  test("imports @workflow/world-postgres rather than inlining it", () => {
    // The artifact, not the config: `neverBundle` is a request, and this is the
    // answer. A static `from"…"` or a dynamic `import("…")` both count — what
    // must not happen is the package's BODY being copied in, which is what
    // separates its migrator from the migration files beside it.
    expect(bundle).toMatch(/(?:from|import\()\s*"@workflow\/world-postgres/);
  });

  test("resolves the Drizzle migrations it reads off disk", () => {
    // A DIFFERENT regression from the one above, and the A/B says so: with the
    // `neverBundle` entry removed this test still PASSES, because the package is
    // installed either way — the bug was that the bundled copy did not USE it.
    // So the import assertion above is what caught the shipped bug, and this one
    // guards the other direction: a version of the package that stops shipping
    // its migrations, or an install that prunes them, leaves the migrator
    // resolvable and still unable to read a journal.
    //
    // `readMigrationFiles` wants a real directory, resolved relative to the
    // package's own location — so the assertion is that resolving from the
    // HARNESS reaches a tree that still has the journal in it.
    const resolved = createRequire(HARNESS).resolve("@workflow/world-postgres");
    const marker = `${join("node_modules", "@workflow", "world-postgres")}`;
    const root = resolved.slice(0, resolved.indexOf(marker) + marker.length);
    expect(root, `unexpected resolution shape: ${resolved}`).not.toBe("");
    expect(
      existsSync(join(root, "src/drizzle/migrations/meta/_journal.json")),
      "the migrator's journal is not on disk beside the resolved package",
    ).toBe(true);
  });

  test("carries a PARSEABLE version for the bundled local workflow world", () => {
    // The other half of the bundling hazard, and the one a `neverBundle` entry
    // would be the wrong fix for. `@workflow/world-local` reads its OWN
    // `package.json` at `<its module dir>/../package.json` to version the data
    // directory — so bundled it reads whatever sits beside `harness.mjs`
    // instead: `packages/aai-guest/package.json` under the subprocess backend
    // (wrong, but parseable), and NOTHING at `/opt/package.json` in the baked
    // image. The unreadable case fell back to the literal string `"bundled"`,
    // which the package's own `parseVersion` rejects — so every databaseless
    // deployed agent that declared a workflow logged
    // `Workflow world (local) failed to start: Invalid version string:
    // "bundled"` and had no workflows at all.
    //
    // Externalizing it is not the remedy: `@workflow/core` imports it
    // STATICALLY, so the harness would evaluate it (and undici, zod, ulid,
    // async-sema) on every spawn, including the voice agents that declare no
    // workflow. The fix is the pnpm patch in `patches/`, which returns the
    // package's real version from a constant and never touches the disk. This
    // asserts on the artifact that actually ships.
    expect(bundle, "world-local is not in the bundle — has it become external?").toContain(
      '"@workflow/world-local"',
    );
    expect(
      bundle,
      "the unparseable version sentinel is back — is the pnpm patch applied?",
    ).not.toMatch(/version:\s*"bundled"/);
  });

  test("keeps the build toolchain external too", () => {
    // The older half of the list, asserted the same way — it is the precedent
    // `@workflow/world-postgres` now follows, and bundling rolldown's native
    // binaries would break the harness in a way no unit test would see.
    for (const specifier of ["@vitejs/plugin-react", "@tailwindcss/vite"]) {
      expect(bundle, `${specifier} looks inlined`).toContain(specifier);
    }
  });
});

/**
 * NOT covered here: that a Postgres world actually MIGRATES. That needs a real
 * database and the scenario tier — `workflow-world.scenario.test.ts` is where it
 * belongs, and its absence is why the two structural checks above assert on the
 * ARTIFACT rather than on `tsdown.config.ts` alone. The distinction matters: a
 * config assertion passes on a build that never ran.
 */
