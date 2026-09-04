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

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

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
    // The verify-deps-before-run opt-out is easy to forget and its absence is
    // invisible: the install still succeeds, and only the LATER `pnpm run`
    // calls trip over the check it disables. It lived in `.npmrc` until pnpm 11
    // stopped reading pnpm settings from there at all (measured: the key
    // resolves to `undefined` from `.npmrc` on 11.24.0, `false` from the
    // workspace yaml), so it moved. Assert the CARRIER is copied, DERIVED from
    // wherever the setting actually is — a hardcoded filename is what made this
    // assertion pass right up until the file it named stopped carrying it.
    expect(rootFiles).toContain("pnpm-lock.yaml");
    expect(rootFiles).toContain("pnpm-workspace.yaml");
    const optOutCarriers = rootFiles.filter((file) =>
      readFileSync(path.join(REPO_ROOT, file), "utf8").includes("verifyDepsBeforeRun"),
    );
    expect(optOutCarriers).not.toHaveLength(0);
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
 * `patchedDependencies` in pnpm-workspace.yaml names a patch FILE per
 * dependency, and pnpm reads that file during install to hash the patched
 * tarball against what the lockfile records. The yaml is copied byte-for-byte
 * into the install layer, so a declaration whose file is NOT staged beside it
 * fails the layer outright:
 *
 *     ENOENT: no such file or directory, open '/app/patches/<name>.patch'
 *
 * Observed on a real `modal deploy`, and the reason it is a test rather than a
 * comment is that every OTHER signal is green: the patch is in the tree, so
 * `pnpm install` works for every developer and every CI job, and only the
 * install layer — which sees a staged subset of the repo — is missing it. It
 * is the same drift this file's other tests cover, by a route the whitelist of
 * manifest FIELDS cannot see: the input is a whole file, named from the yaml.
 */
describe("modal image patched dependencies", () => {
  /** The patch paths the declaration names, parsed independently of the Python. */
  function declaredPatches(): string[] {
    const body = /^patchedDependencies:[ \t]*\n((?:[ \t]+\S.*\n)+)/m.exec(workspaceYaml)?.[1];
    if (body === undefined) return [];
    // Greedy up to the LAST colon: the key is quoted and carries an `@version`.
    return [...body.matchAll(/^[ \t]+\S.*:[ \t]*(\S+?)[ \t]*$/gm)].map((m) =>
      (m[1] as string).replaceAll(/^["']|["']$/g, ""),
    );
  }

  test("stages every patch file the workspace declares", () => {
    const patches = declaredPatches();
    // No patches is a legitimate state — but then the yaml must not declare
    // any, or the parse above has silently stopped matching.
    if (patches.length === 0) {
      expect(workspaceYaml).not.toMatch(/^patchedDependencies:/m);
      return;
    }
    // A declared patch that is not in the tree fails the install layer the
    // same way a missing one does, so both halves are checked here.
    for (const rel of patches) {
      expect(rel).toMatch(/\.patch$/);
      expect(() => readFileSync(path.join(REPO_ROOT, rel))).not.toThrow();
    }
    // And the stager has to actually copy them. Named rather than inlined so
    // the container re-import suite below can hold every repo read in one
    // place; the call is what wires it in.
    expect(modalImagePy).toMatch(/def _stage_install_inputs[\s\S]*?_patch_paths\(/);
  });

  test("derives the paths from the declaration instead of listing them", () => {
    // A listed `patches/…` would be a second place to remember, which is the
    // whole failure: the declaration and the staged tree disagreed.
    for (const file of pyTuple("INSTALL_ROOT_FILES")) expect(file).not.toMatch(/\.patch$/);
    expect(modalImagePy).toMatch(
      /PATCHED_DEPENDENCIES_BLOCK = re\.compile\(\s*r?"\^patchedDependencies:/,
    );
  });

  test("refuses a declaration it cannot read, rather than staging nothing", () => {
    // The regex handles the block form the yaml uses today. Reformatted to
    // flow style (`patchedDependencies: {…}`) it would match nothing — and
    // returning `[]` there hands back the ENOENT above, one layer later and
    // with nothing pointing here. So the empty parse must raise.
    const body = /^def _patch_paths\([\s\S]*?\n(?=\S)/m.exec(modalImagePy)?.[0];
    expect(body, "def _patch_paths not found in scripts/modal_image.py").toBeDefined();
    expect(body).toMatch(/if not paths and PATCHED_DEPENDENCIES_KEY\.search\(/);
    expect(body).toContain("raise RuntimeError");
  });
});

/**
 * Modal re-imports the deploy script INSIDE every container to hydrate the
 * function, so `build_image` runs twice in two different filesystems: once
 * locally with the repo present, and once in a container where it is not and
 * where `REPO_ROOT` (derived from `__file__`, mounted at `/root/`) resolves to
 * `/`. Modal's own `Image` builder calls are lazy, so naming `REPO_ROOT` in
 * one is harmless; computing an ARGUMENT to one by reading the filesystem is
 * not — `_stage_install_inputs` did, and the container died at import with
 * `FileNotFoundError: '/pnpm-lock.yaml'`.
 *
 * It is worth a test because every signal a deploy has is blind to it.
 * `modal deploy` exits 0, the image builds, CI goes green, the app reads
 * `deployed`, and the PREVIOUS deploy's containers keep serving — so the
 * request log is clean too. What actually shipped is a service that cannot
 * scale out or replace a container, and that goes down whenever the last old
 * one does. Observed in production 2026-08-09: 13 failed container starts over
 * four minutes behind a Deploy workflow that reported success, and a
 * `Function modal_deploy.server is crash-looping` line in an app log nobody
 * was reading.
 *
 * Static, because importing the Python needs modal installed and the real
 * check — does a container actually start — belongs to the deploy workflow's
 * post-deploy gate, which catches this and every other startup failure.
 */
describe("modal image container re-import", () => {
  /**
   * Docstrings and comments stripped — this whole check is about which lines
   * EXECUTE, and the prose here discusses `REPO_ROOT` at length.
   */
  const code = modalImagePy.replaceAll(/"""[\s\S]*?"""/g, "").replaceAll(/^\s*#.*$/gm, "");

  /** The body of a top-level `def`, up to the next top-level statement. */
  function pyFunctionBody(name: string): string {
    const body = new RegExp(`^def ${name}\\(([\\s\\S]*?)\\n(?=\\S)`, "m").exec(code)?.[0];
    if (body === undefined) throw new Error(`def ${name} not found in scripts/modal_image.py`);
    return body;
  }

  test("stages nothing when the repo is not there", () => {
    const body = pyFunctionBody("_stage_install_inputs");
    const guard = body.indexOf("if not modal.is_local():");
    expect(guard, "_stage_install_inputs must short-circuit off-host").toBeGreaterThan(-1);
    // Position, not presence: a guard placed after the first REPO_ROOT read
    // throws before it runs, which is the bug with a comment on it.
    const firstRead = body.indexOf("REPO_ROOT");
    expect(firstRead).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstRead);
    // And it has to actually leave the function.
    expect(body.slice(guard)).toMatch(/if not modal\.is_local\(\):\n\s+return /);
  });

  test("reads the filesystem in one place, so the guard covers all of it", () => {
    // Every eager repo read must live behind the guard above. A second helper
    // called from `build_image` would reintroduce the crash with this suite
    // still green, so pin the count rather than the one call site.
    const readers = [...code.matchAll(/^def (_?\w+)\([\s\S]*?\n(?=\S)/gm)].filter(
      (m) => m[0].includes("REPO_ROOT") && !m[0].startsWith("def build_image"),
    );
    expect(readers.map((m) => m[1])).toEqual(["_stage_install_inputs"]);
  });
});

/**
 * `BUILD_COMMAND` is a hand-ordered list of `pnpm --filter … build` steps, and
 * nothing about the workspace forces a new package into it. `aai-runtime` was
 * extracted into its own package and left out of it: the image built GREEN and
 * the entry then died at warm-up on `ERR_MODULE_NOT_FOUND` for
 * `/app/packages/aai-studio-server/node_modules/@alexkroman1/aai-runtime/dist/internal.js`.
 * Nothing local could see it — that subpath resolves to `internal.ts` under the
 * `@dev/source` condition, so only an install without that condition, i.e. the
 * image, reaches `dist/`.
 *
 * DERIVED, not pinned: every `workspace:*` dependency of the studio server that
 * HAS a build script must be built. That is what excludes `aai-server` and
 * `aai-templates` without naming them — they have no build, which is exactly
 * the reason the Python's own comment gives for omitting `aai-server`.
 */
describe("modal image build command", () => {
  type Manifest = {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const manifest = (dir: string): Manifest =>
    JSON.parse(readFileSync(path.join(REPO_ROOT, "packages", dir, "package.json"), "utf-8"));

  test("builds every workspace dependency of the server entry that has a build", () => {
    const dirByName = new Map<string, string>();
    // `withFileTypes` because `packages/` collects non-package entries (a
    // stray `.DS_Store` made the first version of this throw ENOTDIR).
    for (const entry of readdirSync(path.join(REPO_ROOT, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = manifest(entry.name).name;
      if (name !== undefined) dirByName.set(name, entry.name);
    }

    const studio = manifest("aai-studio-server");
    const needsBuild = Object.entries({ ...studio.dependencies, ...studio.devDependencies })
      .filter(([, range]) => range.startsWith("workspace:"))
      .map(([name]) => name)
      .filter((name) => {
        const dir = dirByName.get(name);
        return dir !== undefined && manifest(dir).scripts?.build !== undefined;
      });

    // A floor, because the whole assertion below is a loop over this list: a
    // scan that stopped resolving manifests would pass vacuously. Measured 4.
    expect(
      needsBuild.length,
      "no buildable workspace deps found — the scan is broken",
    ).toBeGreaterThan(2);

    const built = pyTuple("BUILD_COMMAND").join("");
    for (const name of needsBuild) {
      // The list filters by unscoped name for most packages and by the scoped
      // name for aai-cli; accept either. The trailing ` build` is what stops
      // `aai` matching the `aai-runtime` step.
      const unscoped = name.replace(/^@[^/]+\//, "");
      expect(built, `BUILD_COMMAND does not build ${name}`).toMatch(
        new RegExp(`--filter (?:@[^/]+/)?${unscoped} build`),
      );
    }
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
    expect(tsdown).toContain('entry: ["src/index.ts"]');
    expect(tsdown).toContain('outDir: "dist"');
    // Ordering is the whole point: warming before the build would cache a
    // stale bundle, or none at all.
    expect(modalImagePy).toContain(
      ".run_commands(ASSERT_INSTALL_SURVIVED, BUILD_COMMAND, WARM_COMPILE_CACHE)",
    );
  });

  test("sets the mode flag the entry checks", () => {
    expect(modalImagePy).toMatch(/WARM_COMPILE_CACHE = \([\s\S]*?AAI_SERVER_WARMUP=1/);
    const entry = readFileSync(path.join(studioServerDir, "src", "index.ts"), "utf-8");
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

/**
 * Modal's in-container ASGI proxy logs a ~25-line traceback every time a
 * browser walks away from an SSE stream — its relay task is created and never
 * awaited, so CPython hands the exception to the asyncio logger. It is normal
 * traffic (the request itself logs `200 OK`), and on production `aai-server-web`
 * it was ~600 of one hour's ~3,200 log lines against ZERO 5xx.
 * `install_proxy_noise_filter` collapses it to one line.
 *
 * Static, like the rest of this file — the Python is the source of truth and
 * importing it needs modal installed. What is pinned here is what rots
 * SILENTLY, and everything about this rots silently in the same direction:
 * toward suppressing more than it should, in a log nobody reads until an
 * incident. A filter that stops matching merely restores the noise; one that
 * over-matches eats the traceback you needed.
 */
describe("modal proxy log noise", () => {
  const deployPy = readFileSync(
    path.join(REPO_ROOT, "packages/aai-server/modal_deploy.py"),
    "utf-8",
  );

  test("is installed before the port opens, or it filters nothing", () => {
    // An uninstalled filter is invisible: the log looks exactly as it did.
    expect(deployPy).toMatch(/^from modal_image import .*install_proxy_noise_filter/m);
    // To the next top-level statement, or to EOF — `server()` is the last
    // thing in the file today, and a regex that silently matched nothing
    // would make every assertion below vacuous.
    const body = /def server\(\) -> None:\n([\s\S]*?)(?=\n\S|$)/.exec(deployPy)?.[1];
    expect(body, "def server() not found in modal_deploy.py").toBeDefined();
    expect(body).toContain("install_proxy_noise_filter()");
    // Before run_node, which blocks serving traffic for the container's life.
    expect(body?.indexOf("install_proxy_noise_filter()")).toBeLessThan(
      body?.indexOf("run_node(") ?? -1,
    );
  });

  test("needs BOTH discriminators, so it can't decay into swallowing asyncio", () => {
    // The exception type alone would match one of OUR tasks failing the same
    // way; the coroutine name is what scopes it to Modal's own relay.
    expect(modalImagePy).toContain('PROXY_NOISE_CORO = "_proxy_http_request"');
    expect(modalImagePy).toMatch(/PROXY_NOISE_EXCEPTIONS = \(\s*"ClientPayloadError"/);
    const predicate = /def _is_abandoned_stream\([\s\S]*?\n(?=\S)/.exec(modalImagePy)?.[0];
    expect(predicate).toBeDefined();
    expect(predicate).toContain("PROXY_NOISE_EXCEPTIONS");
    expect(predicate).toContain("PROXY_NOISE_CORO");
  });

  test("collapses the record rather than dropping it", () => {
    // The count and the timing ARE the diagnostic — the server guide's rule
    // for reading these is to join a RISE to the request log, which a dropped
    // record makes impossible. Both filter paths must therefore return True.
    const filter = /class _ProxyNoiseFilter[\s\S]*?\n(?=\S)/.exec(modalImagePy)?.[0];
    expect(filter).toBeDefined();
    expect(filter).not.toMatch(/return False/);
    expect((filter?.match(/return True/g) ?? []).length).toBe(2);
    // Clearing only `exc_info` leaves the formatter's cached render behind,
    // and the traceback prints anyway.
    expect(filter).toContain("record.exc_info = None");
    expect(filter).toContain("record.exc_text = None");
  });
});

/**
 * The web function's REGION preference.
 *
 * Static, like the rest of this file. What rots here rots in one direction and
 * takes production with it: the service was once pinned to a bare `us-east-2`
 * and an exhausted region placed NOTHING — zero tasks under `MIN_CONTAINERS=1`,
 * no logs at all, and no redeploy that recovers it. So the list is the
 * invariant, not the preference: a fallback entry is what makes that state
 * unreachable, and "tidy the list down to the one region we actually want" is
 * exactly the edit that reintroduces it.
 *
 * The FIRST entry is pinned separately, and to the database's own region,
 * because that is the entire reason the preference exists — a journal call is
 * ~1-2 ms in-region against ~460 ms out of it, and a run pays that per step.
 * A first entry that drifts away from Supabase leaves the risk and deletes the
 * benefit, which no other assertion here would notice.
 */
describe("modal web function region", () => {
  const deployPy = readFileSync(
    path.join(REPO_ROOT, "packages/aai-server/modal_deploy.py"),
    "utf-8",
  );
  const regions = [
    ...(/^REGIONS = \[([^\]]*)\]/m.exec(deployPy)?.[1]?.matchAll(/"([^"]+)"/g) ?? []),
  ]
    .map((match) => match[1])
    .filter((region) => region !== undefined);

  test("is a LIST with a fallback, never a single region", () => {
    // A regex that stopped matching would make every assertion below vacuous.
    expect(regions.length, "REGIONS not found in modal_deploy.py").toBeGreaterThan(0);
    expect(
      regions.length,
      "REGIONS has one entry: an exhausted region places NOTHING, with no logs and no recovery",
    ).toBeGreaterThan(1);
    expect(new Set(regions).size, "a duplicate entry is not a fallback").toBe(regions.length);
  });

  test("prefers the region the platform database is in", () => {
    // Supabase project `aai` is us-east-2. The whole point of the preference.
    expect(regions[0]).toBe("us-east-2");
  });

  test("names only regions a real deploy has accepted", () => {
    // Modal validates region strings SERVER-side, at deploy time, and rejects
    // one this workspace may not name:
    //
    //   Regions us-east-1 are not supported. See
    //   https://modal.com/docs/guide/region-selection for supported regions
    //
    // That failure is invisible to every gate in this repository — the file
    // parses, the constant is a list, its first entry is still the database's
    // region — and it fails the DEPLOY, so the app keeps serving the previous
    // revision and the release ships nothing. Hence an allowlist rather than a
    // shape rule: nothing local can tell a supported region from an
    // unsupported one, so a new entry is a claim that `modal deploy` accepted
    // it, and adding one here means having deployed it.
    const DEPLOY_ACCEPTED = new Set(["us-east-2", "us-east"]);
    for (const region of regions) {
      expect(
        DEPLOY_ACCEPTED.has(region),
        `REGIONS names "${region}", which no deploy has accepted — Modal rejects an ` +
          "unsupported region at deploy time, so this ships nothing. Deploy it first, then " +
          "add it here.",
      ).toBe(true);
    }
  });

  test("is actually PASSED to the function, or it pins nothing", () => {
    // The constant existing is not the same as the decorator reading it, and
    // an unread constant looks exactly like a configured one in a diff.
    expect(deployPy).toMatch(/^ +region=REGIONS,$/m);
  });

  test("is exported to guest sandboxes DERIVED, never as a second literal", () => {
    // Guests place against the same preference (modal-sandbox-env.ts parses
    // `MODAL_SANDBOX_REGION`), and a run's journal calls are made BY THE GUEST
    // — one platform round trip each, sequentially, ~24 ms out of region
    // against ~2 ms in it. Written as its own string this would be the third
    // copy of a region list in this repository and the one nothing compares:
    // the host would keep preferring us-east-2 while guests drifted, with a
    // green deploy and no symptom but latency. So the assertion is on the
    // JOIN, not on the value.
    expect(deployPy).toMatch(/^ +"MODAL_SANDBOX_REGION": ",".join\(REGIONS\),$/m);
  });
});
