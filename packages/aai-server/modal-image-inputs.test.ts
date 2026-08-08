// Copyright 2026 the AAI authors. MIT license.
/**
 * `scripts/modal_image.py` builds the deploy image in two halves: the
 * dependency install first, from a normalized copy of the workspace
 * manifests, then the source tree on top. The split is what lets a container
 * cold-start against a `node_modules` layer some worker already holds instead
 * of one rebuilt on every deploy.
 *
 * It only works while the Python's idea of "the install inputs" matches the
 * repo's, and both halves of that drift silently in the same direction —
 * toward an install that is subtly not the one the tests ran against:
 *
 * - a workspace glob added to `pnpm-workspace.yaml` and not to
 *   `WORKSPACE_MANIFEST_GLOBS` leaves a package out of the install layer;
 * - a manifest that grows a dependency-declaring field the whitelist does not
 *   carry (`overrides`, `resolutions`, `optionalDependencies`) resolves one
 *   tree in the layer and a different one in the source on top of it.
 *
 * The first is loud — `--frozen-lockfile` calls it a lockfile mismatch at
 * image build. The SECOND is not: the install succeeds, and the image simply
 * ships dependencies nobody asked for. Hence a test rather than a comment.
 *
 * Read as text rather than imported, because the source of truth is Python.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const modalImagePy = readFileSync(path.join(REPO_ROOT, "scripts/modal_image.py"), "utf-8");
const workspaceYaml = readFileSync(path.join(REPO_ROOT, "pnpm-workspace.yaml"), "utf-8");

/**
 * The string entries of a top-level Python tuple constant, written on one
 * line or many — the constants here are formatted by whatever the ruff line
 * limit does with them, which is not something a test should pin.
 */
function pyTuple(name: string): string[] {
  const body = new RegExp(`^${name} = \\(([\\s\\S]*?)\\)`, "m").exec(modalImagePy)?.[1];
  if (body === undefined) throw new Error(`${name} not found in scripts/modal_image.py`);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

/** The `packages:` globs from pnpm-workspace.yaml, before the first blank-line block. */
function workspaceGlobs(): string[] {
  const body = /^packages:\n((?:\s*-\s.*\n)+)/m.exec(workspaceYaml)?.[1];
  if (body === undefined) throw new Error("no `packages:` list in pnpm-workspace.yaml");
  return [...body.matchAll(/-\s*"?([^"\n]+?)"?\s*$/gm)].map((m) => m[1] as string);
}

describe("modal image install inputs", () => {
  test("covers every workspace glob pnpm resolves", () => {
    // `packages/*` in the workspace ⇒ `packages/*/package.json` in the stager.
    const expected = workspaceGlobs().map((glob) => `${glob}/package.json`);
    // `arrayContaining([])` is satisfied by anything, so an empty parse would
    // make this pass while checking nothing.
    expect(expected.length).toBeGreaterThan(0);
    expect(pyTuple("WORKSPACE_MANIFEST_GLOBS")).toEqual(expect.arrayContaining(expected));
  });

  test("copies the files that define the dependency graph", () => {
    const rootFiles = pyTuple("INSTALL_ROOT_FILES");
    // `.npmrc` is easy to forget and its absence is invisible: the install
    // still succeeds, and only the LATER `pnpm run` calls trip over the
    // verify-deps check it disables.
    expect(rootFiles).toContain("pnpm-lock.yaml");
    expect(rootFiles).toContain("pnpm-workspace.yaml");
    expect(rootFiles).toContain(".npmrc");
    // Same reasoning as the `expected.length` guard in the test above: a
    // parse that returned nothing would make the sweep below vacuous.
    expect(rootFiles.length).toBeGreaterThan(0);
    for (const file of rootFiles) {
      expect(() => readFileSync(path.join(REPO_ROOT, file))).not.toThrow();
    }
  });

  // The reason the layer survives a release at all: `version` moves on every
  // changeset release, which is exactly when a deploy happens.
  test("normalizes the version out, or the layer misses on every deploy", () => {
    expect(pyTuple("INSTALL_MANIFEST_FIELDS")).not.toContain("version");
  });

  test("keeps every dependency-declaring field any manifest actually uses", () => {
    // Not an allowlist over all of package.json — only over the keys that
    // change what `pnpm install` resolves. Cosmetic fields (`exports`,
    // `files`, `publishConfig`) are meant to be dropped.
    const DEPENDENCY_FIELDS = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "optionalDependencies",
      "bundleDependencies",
      "bundledDependencies",
      "overrides",
      "resolutions",
      "pnpm",
    ];
    const kept = new Set(pyTuple("INSTALL_MANIFEST_FIELDS"));
    const manifests = [
      "package.json",
      "docs/package.json",
      ...workspaceGlobs()
        .filter((glob) => glob.endsWith("/*"))
        .flatMap(() =>
          // Only `packages/*` expands; the members are the sibling dirs here.
          readFileSync(path.join(REPO_ROOT, "pnpm-lock.yaml"), "utf-8")
            .split("\n")
            .flatMap((line) => /^ {2}(packages\/[a-z0-9-]+):$/.exec(line)?.[1] ?? [])
            .map((dir) => `${dir}/package.json`),
        ),
    ];
    expect(manifests.length).toBeGreaterThan(2);

    for (const rel of manifests) {
      const manifest: Record<string, unknown> = JSON.parse(
        readFileSync(path.join(REPO_ROOT, rel), "utf-8"),
      );
      for (const field of DEPENDENCY_FIELDS) {
        if (field in manifest) expect.soft(kept, `${rel} declares ${field}`).toContain(field);
      }
    }
  });

  // Every workspace dependency being `workspace:*` is what makes dropping
  // `version` safe — a ranged spec (`workspace:^`) would resolve against the
  // version the normalized manifest no longer carries.
  test("has no ranged workspace specs, which dropping the version would break", () => {
    const lock = readFileSync(path.join(REPO_ROOT, "pnpm-lock.yaml"), "utf-8");
    expect(lock).not.toMatch(/specifier: workspace:[~^]/);
  });
});

/**
 * The image bakes a V8 compile cache for the SERVER entry the same way the
 * guest snapshot bakes one for the harness (~600ms → ~395ms measured on the
 * built bundle). Three things have to agree across three files, and two of the
 * three disagreements are SILENT — the image builds, the container boots, and
 * the cache is merely empty or unread, costing ~200ms on every cold start
 * forever:
 *
 * - the warm-up must run the entry `BUILD_COMMAND` actually produces;
 * - the mode flag it sets must be the one the entry checks;
 * - the runtime env must point at the directory the build warmed.
 *
 * The remaining half — "the entry really exits 0 in warm-up mode" — is
 * deliberately NOT a test here: the warm-up is a fatal step of the image
 * build, so a broken guard fails `modal deploy` loudly rather than shipping a
 * cold cache. `dist/` is also not available to this suite (`test` depends on
 * `^build`, not its own build), so a spawn test would have to skip itself.
 */
describe("modal image compile cache", () => {
  const studioServerDir = path.join(REPO_ROOT, "packages/aai-studio-server");

  test("warms the entry the build produces, after the build", () => {
    expect(modalImagePy).toContain(
      'SERVER_ENTRY = "/app/packages/aai-studio-server/dist/index.mjs"',
    );
    // The path above is only correct while the studio-server build still emits
    // `dist/index.mjs` from `index.ts` — the one place that decides it.
    const tsdown = readFileSync(path.join(studioServerDir, "tsdown.config.ts"), "utf-8");
    expect(tsdown).toContain('entry: ["index.ts"]');
    expect(tsdown).toContain('outDir: "dist"');
    // Ordering is the whole point: warming before the build would cache a
    // stale bundle, or none at all.
    expect(modalImagePy).toContain(
      ".run_commands(ASSERT_INSTALL_SURVIVED, BUILD_COMMAND, WARM_COMPILE_CACHE)",
    );
  });

  test("sets the mode flag the entry checks", () => {
    expect(modalImagePy).toMatch(/WARM_COMPILE_CACHE = \([\s\S]*?AAI_SERVER_WARMUP=1/);
    const entry = readFileSync(path.join(studioServerDir, "index.ts"), "utf-8");
    expect(entry).toContain('process.env.AAI_SERVER_WARMUP === "1"');
    // Exiting is what makes it a warm-up rather than a boot: the build step
    // would otherwise hang on a listening server until Modal killed it.
    expect(entry).toMatch(/AAI_SERVER_WARMUP === "1"\)\s*{\s*process\.exit\(0\);/);
  });

  test("points the runtime at the directory it warmed", () => {
    // Warming a cache the container never consults is the silent failure this
    // pins: both sides must name the same constant, not the same literal.
    expect(modalImagePy).toMatch(
      /WARM_COMPILE_CACHE = \(\s*f"NODE_COMPILE_CACHE=\{SERVER_COMPILE_CACHE\}/,
    );
    expect(modalImagePy).toContain('"NODE_COMPILE_CACHE": SERVER_COMPILE_CACHE');
  });
});
