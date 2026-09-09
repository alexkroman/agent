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
import config, { BUNDLED_WORKSPACE_DEPS } from "../tsdown.config.ts";

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
 * A workspace package `aai-server`'s SHIPPED source imports must be declared
 * HERE too, so bundling that package in never MOVES a sibling's modules.
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
 * installed?" on a platform where it plainly was.
 *
 * The REAL fix was to stop resolving it from a package that gets bundled:
 * `createOrchestrator` takes a required `clientDir` and this entry passes
 * `defaultClientDir()` in, so the resolution happens in the package that
 * declares aai-ui (`createDefaultClientHandlers` carries that argument).
 * This check is what keeps the NEXT one from being found in production
 * instead — it is a property of the bundling boundary, not of that one value.
 *
 * Two scoping notes. It reads SHIPPED source only: a test file is not in the
 * entry graph, which is exactly why aai-server's remaining aai-ui imports live
 * in `orchestrator.test.ts` and `transport-websocket.test.ts`. And it checks
 * the IMPORT, not the `require.resolve` — the resolution that broke lives in
 * aai-ui, three modules from anything aai-server wrote, so a scan for resolve
 * calls in the bundled source would have seen nothing. What is knowable here
 * is which packages the bundle swallows.
 *
 * This package's own guide states the mirror rule — "anything else that
 * resolves a workspace sibling by module location owes the same fallback" (the
 * shape `guestPackageDir` carries for `aai-guest`, which is RESOLVED but never
 * imported, so it does not appear here): keeping the package external is the
 * fix when the sibling is imported, and a fallback is the fix when it is only
 * ever resolved.
 */
describe("workspace siblings of the bundled server", () => {
  /** Every workspace package `aai-server`'s SHIPPED source imports by name. */
  function serverWorkspaceImports(): string[] {
    const found = new Set<string>();
    for (const name of readdirSync(SERVER_SRC)) {
      // Tests are not in the entry graph, so their imports are not bundled.
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const source = readFileSync(path.join(SERVER_SRC, name), "utf-8");
      // The character class excludes `/`, so a subpath specifier
      // (`@alexkroman1/aai-runtime/internal`) yields the PACKAGE — which is
      // the granularity externality is decided at.
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
    expect(imports.length).toBeGreaterThan(1);
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

  // The regression, stated as the property that now holds rather than as the
  // declaration that patched it: the agent surface serves the default client
  // from an INJECTED directory, so the package that gets bundled names aai-ui
  // nowhere outside its own tests.
  test("do not include the default client, which is injected instead", () => {
    expect(serverWorkspaceImports()).not.toContain("@alexkroman1/aai-ui");
    // …and the composition root is the one that resolves it, which is what
    // keeps the specifier external and the dependency honest to knip.
    const entry = readFileSync(path.join(PACKAGE_DIR, "index.ts"), "utf-8");
    expect(entry).toContain('from "@alexkroman1/aai-ui/client-dir"');
    expect(entry).toContain("clientDir: defaultClientDir()");
    expect(Object.keys(manifest.dependencies)).toContain("@alexkroman1/aai-ui");
  });
});

/**
 * The config must keep using `deps.alwaysBundle`, and `external` must keep
 * naming the packages that cannot survive being inlined.
 *
 * Value assertions over the config's own default export, because the checks
 * above are blind to both. They hold `BUNDLED_WORKSPACE_DEPS` to the specifiers
 * `aai-server` is imported by — which stays true no matter which KEY the config
 * passes that constant under, so swapping `alwaysBundle` for `onlyBundle`
 * passes every one of them.
 *
 * That swap is not hypothetical and it is silent in every direction anyone
 * looks: it externalizes `aai-server` ITSELF (the bundle goes 5.55 MB to
 * 278 kB and imports `aai-server/config`, `aai-server/http`, … as bare
 * specifiers), the build succeeds, and `AAI_SERVER_WARMUP=1 node dist/index.mjs`
 * exits 0 — because those subpaths resolve to `.ts` SOURCE, which Node
 * type-strips. What it costs is the cold start that config's own comment exists
 * to protect: ~72 TypeScript modules resolved, read and compiled before the
 * first request, and a compile cache keyed on 72 files instead of one bundle.
 * It also suppresses tsdown's `Detected dependencies in bundle` hint, which is
 * `check:bundled-deps`' only input — so that gate fails loudly on the absence
 * rather than baselining an empty set, and this is the same property from the
 * authoring side.
 */
describe("the bundling posture", () => {
  /** The one build config — `defineConfig` takes an array; the entry is sole. */
  const entry = config[0];

  test("bundles aai-server rather than externalizing everything else", () => {
    expect(entry?.deps).toBeDefined();
    const deps = entry?.deps as { alwaysBundle?: unknown; onlyBundle?: unknown };
    // The SAME value the specifier checks above are written against, so those
    // cannot be pinning a constant this config no longer passes anywhere.
    expect(deps.alwaysBundle).toBe(BUNDLED_WORKSPACE_DEPS);
    expect(deps.onlyBundle, "onlyBundle externalizes aai-server itself — see above").toBe(
      undefined,
    );
  });

  /**
   * The roots kept whole, and why these two.
   *
   * `modal` is named rather than the five packages that actually read files off
   * disk (`protobufjs`, `@grpc/proto-loader`, `cbor-x` -> `cbor-extract` ->
   * `node-gyp-build-optional-packages` / `detect-libc`): they are all its tree,
   * so externalizing the ROOT keeps them resolving through its own
   * `node_modules` and costs one declaration instead of five. Measured — it
   * takes 26 of the 52 swallowed packages out with it.
   *
   * `microsandbox` is the second, found by auditing the survivors rather than
   * from the incident: `dist/internal/resolve-binary.js` locates a native addon
   * from `import.meta.url`, and shipped code reaches it through
   * `await import("microsandbox")`, which rolldown inlines. It is a local-dev
   * backend behind a `try`/`catch` and a devDependency, so it is deliberately
   * NOT declared here — unresolvable in production is what a dev-only backend
   * should be, and bundling it is the only reason it was ever reachable there.
   */
  test("keeps the packages that resolve files by their own location whole", () => {
    const external = entry?.external as string[] | undefined;
    expect(external).toContain("modal");
    expect(external).toContain("microsandbox");
    // An external specifier is resolved at RUNTIME from `dist/`, so anything
    // production has to load must also be declared, or it is a bundle that
    // builds clean and cannot boot.
    expect(Object.keys(manifest.dependencies)).toContain("modal");
  });
});
