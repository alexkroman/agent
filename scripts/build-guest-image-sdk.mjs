#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.

/**
 * Packing THIS CHECKOUT's SDK into the guest image's build context.
 *
 * Split out of `build-guest-image.mjs` when that file reached its length cap, and
 * the seam is a real one rather than a convenience: this is the only part of the
 * image build that reads the WORKSPACE rather than the recipe constants, and it
 * is also what `ensure-guest-image.mjs` needs in order to decide whether a
 * rebuild is owed.
 *
 * Why a local image installs source and not the registry is in
 * `packages/aai-guest/CLAUDE.md`, "And the SDK in a LOCAL image is this
 * checkout's, not npm's" — including the polarity rule (a pushed image may never
 * carry unpublished code) and the failure that motivated it.
 *
 * @module build-guest-image-sdk
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path, { posix } from "node:path";
import process from "node:process";
import { extractStringArray } from "./build-guest-image-extract.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_DIR = path.join(REPO_ROOT, "packages", "aai-server");
const GUEST_DIR = path.join(REPO_ROOT, "packages", "aai-guest");

/**
 * Where a local build stages this checkout's packed SDK.
 *
 * Inside the build CONTEXT (the guest package), because a `COPY` cannot reach
 * outside it. The `.tgz` files are gitignored; the directory is committed with a
 * `.gitkeep` so the Dockerfile's unconditional COPY always has a path.
 */
const SDK_TARBALL_DIR = "sdk-tarballs";

/**
 * Pack the four SDK packages out of THIS checkout and return install specs
 * pointing at them inside the image.
 *
 * ## Why a local image installs source and not the registry
 *
 * A guest's agent bundle resolves `@alexkroman1/*` from the image's
 * `node_modules` (the CLI's worker-bundler runs inside the guest and bundles
 * what it finds). So installing published versions put a developer's guest in a
 * state no release ever produces: the HARNESS was this checkout's, and every
 * BUNDLE it ran was the last published SDK. An unreleased fix was therefore live
 * in one half and absent from the other, silently — which cost a full
 * investigation exactly once, when a guest kept dialling itself for platform
 * calls after the fix for that was already in the tree, because the copy making
 * the call came from npm and was thirteen commits behind.
 *
 * `:local` is a mutable tag that already promises "whatever this checkout is"
 * (see `microsandboxHarnessImageTag`, which refuses to PIN it for that reason).
 * This makes the SDK keep that promise too.
 *
 * ## Built, never assumed
 *
 * `files` on all four is `dist`, so an unbuilt package packs an EMPTY tarball
 * and npm installs a package with no entry points — a failure that surfaces
 * inside a guest as an unresolvable import. `turbo run build` is a no-op when
 * warm (measured: 49ms, FULL TURBO), so there is no reason to guess.
 *
 * The sibling versions come along for free: `pnpm pack` rewrites `workspace:*`
 * to the exact version (and `catalog:` to the real range — see
 * `check:publish-protocols`), so `@alexkroman1/aai-runtime` requires
 * `@alexkroman1/aai@<this version>` and npm satisfies it from the tarball
 * installed beside it rather than fetching the published one. Verified: four
 * tarballs, one `npm install`, one `@alexkroman1/*` copy of each.
 */
export function packWorkspaceSdk(guestRoot) {
  const names = extractStringArray(path.join(SERVER_DIR, "modal-harness-image.ts"), "SDK_PACKAGES");
  const dest = path.join(GUEST_DIR, SDK_TARBALL_DIR);
  mkdirSync(dest, { recursive: true });
  // Stale tarballs from an earlier version would otherwise sit beside the new
  // ones and, being named by version, never be overwritten — and the specs
  // below are resolved by GLOB, so one would silently be installed.
  for (const file of readdirSync(dest)) {
    if (file.endsWith(".tgz")) rmSync(path.join(dest, file));
  }

  console.log(`Building the SDK for a local image (${names.join(", ")})`);
  run("pnpm", ["turbo", "run", "build", ...names.map((n) => `--filter=${n}`)]);

  const specs = [];
  for (const name of names) {
    const dir = path.join(REPO_ROOT, "packages", packageDirFor(name));
    const before = new Set(readdirSync(dest));
    run("pnpm", ["pack", "--pack-destination", dest], { cwd: dir, quiet: true });
    const made = readdirSync(dest).filter((f) => f.endsWith(".tgz") && !before.has(f));
    if (made.length !== 1) {
      throw new Error(
        `pnpm pack in ${path.relative(REPO_ROOT, dir)} produced ${made.length} tarballs, expected 1`,
      );
    }
    // POSIX join, not `path.join`: this path is consumed inside the LINUX image,
    // and on Windows `path.join` would emit backslashes into a docker build arg.
    specs.push(posix.join(guestRoot, SDK_TARBALL_DIR, made[0]));
  }
  return specs;
}

/** `@alexkroman1/aai-ui` -> `aai-ui`, the directory under `packages/`. */
function packageDirFor(name) {
  const dir = name.replace(/^@[^/]+\//, "");
  if (!existsSync(path.join(REPO_ROOT, "packages", dir, "package.json"))) {
    throw new Error(`SDK package ${name} does not map to packages/${dir}`);
  }
  return dir;
}

/**
 * Spawn and throw with the command on a non-zero exit.
 *
 * `quiet` CAPTURES output and replays it only on failure, which `pnpm pack`
 * needs: it prints the whole file list of every tarball, and `--print`'s
 * contract is one JSON object a caller can parse. The slow step (`turbo run
 * build`) inherits instead — a cold build that printed nothing for a minute
 * reads as a hang.
 */
export function run(cmd, args, { cwd = REPO_ROOT, quiet = false } = {}) {
  const { status, error, stdout, stderr } = spawnSync(cmd, args, {
    cwd,
    stdio: quiet ? "pipe" : "inherit",
    encoding: quiet ? "utf-8" : undefined,
  });
  if (error) throw error;
  if (status !== 0) {
    if (quiet) process.stderr.write(`${stdout ?? ""}${stderr ?? ""}`);
    throw new Error(`${cmd} ${args.join(" ")} exited ${status}`);
  }
}

/**
 * The version of each SDK package as THIS CHECKOUT has it installed.
 *
 * The one reading of "which versions is this tree's image made of", shared by
 * `resolveSdkSpecs` (which turns it into `name@version` install specs, and is
 * also what the image TAG is hashed from) and {@link stageSdkPackDir} (which
 * uses it to refuse a pack directory that holds some other release). Two
 * readings would let the tag and the installed bytes disagree, which is
 * precisely the state no gate downstream can see.
 *
 * @returns {Map<string, string>} package name -> installed version
 */
export function sdkInstalledVersions() {
  const guestPkg = JSON.parse(readFileSync(path.join(GUEST_DIR, "package.json"), "utf-8"));
  return new Map(
    sdkPackageNames().map((name) => {
      const declared = guestPkg.dependencies?.[name] ?? guestPkg.devDependencies?.[name];
      if (!declared) {
        throw new Error(`aai-guest package.json no longer declares SDK package ${name}`);
      }
      const installedPath = path.join(GUEST_DIR, "node_modules", name, "package.json");
      if (!existsSync(installedPath)) {
        throw new Error(
          `SDK package ${name} is declared by aai-guest but not installed at ${installedPath} — ` +
            "run pnpm install before building a guest image",
        );
      }
      const { version } = JSON.parse(readFileSync(installedPath, "utf-8"));
      if (typeof version !== "string") {
        throw new Error(`SDK package ${name} has no version in ${installedPath}`);
      }
      return [name, version];
    }),
  );
}

/**
 * Stage the tarballs `changeset pack` produced, and return install specs for
 * them — the form a PUSHED image uses on a release.
 *
 * ## Why a pushed image may install a tarball at all
 *
 * The standing rule is that a registry or push build may never install
 * unpublished code, and it used to be kept by installing `name@version` from
 * npm: if the install resolved, the version was published. That works, and it
 * costs the whole ordering this pipeline was built around — the image cannot be
 * built until the release is not just published but READABLE by an installer,
 * which is a property of npm's caches rather than of anything CI can see.
 *
 * A `changeset pack` directory discharges the same rule directly. Its tarballs
 * are the artifacts `changeset publish --from-pack-dir` uploads, so installing
 * them is installing the release itself — the same bytes, before the registry
 * has finished agreeing that it has them. "Unpublished code" is ruled out by
 * construction rather than by a lookup.
 *
 * Two assertions are what make that true rather than merely intended, and both
 * are fatal:
 *
 * 1. **The plan's version must equal the version this checkout declares.** The
 *    image TAG is hashed from the declared versions ({@link sdkInstalledVersions}
 *    by way of `resolveSdkSpecs`), so a pack directory left over from an earlier
 *    release would produce an image whose tag promises one release and whose
 *    node_modules holds another — the exact "a version number cannot distinguish
 *    a released tree from a dirty one" failure, arriving by a new route.
 * 2. **The tarball must match the integrity `changeset pack` recorded.** Cheap,
 *    and it is the difference between "these are the published bytes" as a claim
 *    and as a check.
 *
 * @param {string} guestRoot - `GUEST_ROOT`, the image-side path the specs resolve under
 * @param {string} packDir - a `changeset pack --out-dir` directory
 * @returns {string[]} image-side tarball paths, one per SDK package
 */
export function stageSdkPackDir(guestRoot, packDir) {
  const planPath = path.join(packDir, "publish-plan.json");
  if (!existsSync(planPath)) {
    throw new Error(
      `${planPath} does not exist — --sdk-pack-dir wants a directory written by ` +
        "`changeset pack --out-dir`",
    );
  }
  const { plan } = JSON.parse(readFileSync(planPath, "utf-8"));
  const packed = new Map(
    (plan ?? [])
      .flat()
      .filter((release) => release.kind === "publish" && release.tarball)
      .map((release) => [release.name, release]),
  );

  const dest = path.join(GUEST_DIR, SDK_TARBALL_DIR);
  mkdirSync(dest, { recursive: true });
  for (const file of readdirSync(dest)) {
    if (file.endsWith(".tgz")) rmSync(path.join(dest, file));
  }

  const specs = [];
  for (const [name, version] of sdkInstalledVersions()) {
    const release = packed.get(name);
    if (!release) {
      throw new Error(
        `${planPath} publishes no ${name} — a pushed image may not mix a packed release with ` +
          "versions resolved from npm. Re-run `changeset pack` against this commit.",
      );
    }
    if (release.version !== version) {
      throw new Error(
        `${planPath} publishes ${name}@${release.version} but this checkout declares ` +
          `${version} — the image tag is hashed from the declared version, so this pack ` +
          "directory belongs to a different release.",
      );
    }
    const tarball = path.join(packDir, release.tarball.path);
    assertIntegrity(tarball, release.tarball.integrity);
    const filename = path.basename(tarball);
    copyFileSync(tarball, path.join(dest, filename));
    // POSIX join for the same reason `packWorkspaceSdk` uses one: this path is
    // consumed inside the LINUX image.
    specs.push(posix.join(guestRoot, SDK_TARBALL_DIR, filename));
  }
  return specs;
}

/**
 * Fail unless `file` hashes to the `sha256-<base64>` integrity string recorded
 * beside it. Only sha256 is accepted — `changeset pack` writes nothing else, and
 * silently skipping an algorithm we do not recognise would turn this check off
 * exactly when the format changed under it.
 *
 * @param {string} file
 * @param {string} integrity
 */
function assertIntegrity(file, integrity) {
  if (!existsSync(file)) {
    throw new Error(`${file} is named by the publish plan but is not in the pack directory`);
  }
  const [algorithm, expected] = String(integrity).split("-", 2);
  if (algorithm !== "sha256" || !expected) {
    throw new Error(`unsupported tarball integrity ${JSON.stringify(integrity)} for ${file}`);
  }
  const actual = createHash("sha256").update(readFileSync(file)).digest("base64");
  if (actual !== expected) {
    throw new Error(
      `${file} does not match the integrity the publish plan recorded ` +
        `(expected sha256-${expected}, got sha256-${actual}) — these are not the bytes that ` +
        "will be published.",
    );
  }
}

/** The four SDK package names, read out of the constant that declares them. */
export function sdkPackageNames() {
  return extractStringArray(path.join(SERVER_DIR, "modal-harness-image.ts"), "SDK_PACKAGES");
}

/**
 * A digest of every SDK input a local image is built FROM — the `dist` trees the
 * tarballs are made of, never the tarballs themselves.
 *
 * Hashing the tarballs is the obvious move and it is wrong: `pnpm pack` writes a
 * gzip member whose bytes are not a pure function of the content, so an unchanged
 * tree can produce a differing archive and a gate built on that would rebuild
 * forever. The `dist` trees are the real inputs.
 *
 * A missing `dist` hashes as `absent` rather than throwing: the caller's question
 * is "has anything CHANGED", and "not built yet" is a state `packWorkspaceSdk`
 * resolves by building.
 */
export function sdkSourceDigest() {
  const hash = createHash("sha256");
  for (const name of sdkPackageNames()) {
    hash.update(`${name}\u0000`);
    const dist = path.join(REPO_ROOT, "packages", packageDirFor(name), "dist");
    if (!existsSync(dist)) {
      hash.update("absent\u0000");
      continue;
    }
    for (const file of walk(dist)) {
      hash.update(`${path.relative(dist, file)}\u0000`);
      hash.update(readFileSync(file));
    }
  }
  return hash.digest("hex");
}

/**
 * Every file under `dir`, SORTED, so the digest is stable.
 *
 * `readdirSync`'s own `recursive` option rather than a hand-rolled recursion —
 * and specifically NOT `fs.globSync("**\/*")`, which is the obvious-looking
 * replacement and would be a silent bug: glob does not match a path segment
 * beginning with a dot, so every dotfile in a `dist/` would drop out of the
 * digest and a change to one would not rebuild the image. Demonstrated on a
 * scratch tree — `readdirSync` recursive answers `[".hidden",
 * "sub/.alsohidden", "sub/plain.txt"]` where `globSync("**\/*")` answers
 * `["sub", "sub/plain.txt"]`, missing two files and offering a directory.
 *
 * The sort is now over whole relative paths rather than per directory level, so
 * the order differs where a filename sorts around a `/` (`a-b` before `a/z`
 * instead of after). That changes this digest ONCE — it is a cache key computed
 * at runtime and committed nowhere, so the cost is a single guest-image rebuild
 * on the next boot, and every run after it is stable again.
 */
function walk(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}
