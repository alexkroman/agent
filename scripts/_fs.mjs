// Copyright 2026 the AAI authors. MIT license.
/**
 * The filesystem-shaped answers every gate script was re-deriving.
 *
 * Four things had been written between two and four times each, and in every
 * case the copies had DIFFERENT behaviour rather than merely different text —
 * which is the argument for one home:
 *
 *   - **`repoRoot`**, spelled `new URL("..", import.meta.url).pathname` in
 *     eleven scripts. A URL pathname is PERCENT-ENCODED, so a checkout under
 *     `/Users/me/my repo/` yields `/Users/me/my%20repo/` and every `join()`
 *     built on it names a directory that does not exist. Two scripts already
 *     used `fileURLToPath`; this is that, once.
 *   - **`readJson`**, defined three times (silent `JSON.parse` in
 *     `_api-contracts-tree.mjs`, silent in `sync-guest-toolchain.mjs`,
 *     fail-loudly in `sync-scaffold-versions.mjs`) plus ~15 inline
 *     `JSON.parse(readFileSync(...))` split roughly evenly between `"utf8"` and
 *     `"utf-8"`. The fail-loudly behaviour is the one worth keeping: a parse
 *     error inside a gate otherwise arrives as `Unexpected token }` with no
 *     path attached.
 *   - **`publishablePackages`**, answered four times with four different error
 *     behaviours (skip on missing manifest, skip on unreadable manifest, report
 *     the parse failure, or throw).
 *   - **`withPackedTarball`**, the `pnpm pack` → tmpdir → read-the-manifest
 *     dance, written by the only two things in the repo that pack.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Code-unit order, never `localeCompare`.
 *
 * Every committed GENERATED artifact in this repo is sorted with it — the API
 * reports and `API-EXPORTS.json`, the gateway model catalog, both ratchet
 * baselines — because a gate then compares that file byte for byte, and
 * `localeCompare` with no explicit locale answers to the runtime's ICU default.
 * The same tree would produce a different file on a different machine and the
 * gate would report a change that is really a locale.
 *
 * It lives in THIS module, rather than beside its rationale in
 * `_api-surface.mjs` (which re-exports it), for a mechanical reason: that module
 * requires api-extractor's bundled TypeScript at load time, and neither the
 * ratchet nor the model generator should pay for a compiler to sort strings.
 */
export function compareNames(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The repository root as a real filesystem path, derived from a script's own
 * `import.meta.url`.
 *
 * Trailing separator included, matching what `new URL("..", …).pathname`
 * produced — every caller feeds it to `join()`, which does not care, and the
 * two spellings staying interchangeable is what keeps this a pure fix.
 *
 * @param {string} importMetaUrl - the CALLER's `import.meta.url`
 * @returns {string}
 */
export function repoRoot(importMetaUrl) {
  return fileURLToPath(new URL("..", importMetaUrl));
}

/**
 * Read and parse a JSON file, failing with the offending PATH in the message.
 *
 * Throws rather than `process.exit`ing, so a caller that wants to keep going
 * (`publishablePackages` skipping an unreadable manifest) can, and a caller that
 * does not gets an uncaught error naming the file — which is still every bit as
 * loud as the exit it replaces, and does not require this module to decide a
 * script's exit code.
 *
 * @param {string | URL} path
 * @returns {unknown}
 */
export function readJson(path) {
  return parseJson(path);
}

/**
 * The fields of a `package.json` that a gate in this repo actually reads.
 *
 * `readJson` returns `unknown`, which is right — it is handed arbitrary JSON.
 * But twelve of its nineteen call sites read a MANIFEST, and every one of them
 * was reaching into that `unknown` for `.name`, `.version`, `.private`. Under
 * `checkJs` each of those is a TS18046, and the two remedies available in
 * annotation-free JS are a per-site JSDoc cast or one typed seam. This is the
 * seam — the same answer `packages/aai/CLAUDE.md` gives for a concentration of
 * identical casts, and the reason it is a fixed field list rather than an index
 * signature: an index signature resolves every property name including a
 * MISTYPED one, which is the class of bug this program was turned on to find.
 *
 * A field a future gate needs is added here, in a diff a reviewer sees.
 *
 * @typedef {object} PackageManifest
 * @property {string} [name]
 * @property {string} [version]
 * @property {boolean} [private]
 * @property {string} [license]
 * @property {string} [packageManager]
 * @property {string | { type?: string, url?: string, directory?: string }} [repository]
 * @property {boolean | string[]} [sideEffects]
 * @property {string[]} [files]
 * @property {Record<string, ExportTarget>} [exports]
 * @property {Record<string, string>} [scripts]
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [devDependencies]
 * @property {Record<string, string>} [peerDependencies]
 * @property {Record<string, string>} [optionalDependencies]
 * @property {Record<string, string>} [engines]
 * @property {Record<string, unknown>} [publishConfig]
 */

/**
 * One entry in an `exports` map: either a bare path, or the condition object
 * this repo actually writes (`@dev/source` + `types` + `import`).
 *
 * Spelled out rather than left as `unknown` because two gates walk this map and
 * both had the same problem: `typeof target === "object"` narrows `unknown` to
 * `object`, and `object` has no index signature, so `target["@dev/source"]` and
 * `target.types` were unreachable. An open condition map is the honest type —
 * the condition names are not a fixed set — and it is still specific enough
 * that reading a nested value off a bare-string entry stays an error.
 *
 * @typedef {string | { [condition: string]: string | undefined }} ExportTarget
 */

/**
 * `readJson` for the file that is a `package.json`.
 *
 * Same read, same fail-loudly behaviour; the only difference is that the result
 * is typed. See {@link PackageManifest}.
 *
 * @param {string | URL} path
 * @returns {PackageManifest}
 */
export function readManifest(path) {
  // The ONE narrowing. `parseJson` is handed arbitrary JSON and rightly says
  // `unknown`; this is the single place that claims a shape for it, so the
  // claim is reviewable here instead of being re-made at twelve call sites.
  return /** @type {PackageManifest} */ (parseJson(path));
}

/**
 * The shared body of `readJson` and `readManifest`.
 *
 * Split out so each can declare its own return type: a JSDoc `@returns` is the
 * only way to say it, and one function cannot carry two.
 *
 * @param {string | URL} path
 * @returns {unknown}
 */
function parseJson(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`failed to read ${path}: ${err.message}`, { cause: err });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${err.message}`, { cause: err });
  }
}

/**
 * The `packages/*` directories whose manifest is not `"private": true`.
 *
 * Repo-relative (`packages/aai`), sorted, and a directory with no readable
 * manifest is SKIPPED rather than failing the caller — `packages/*` also holds
 * scratch directories in a dirty worktree, and a gate that dies on one is a gate
 * that cannot run where it is needed most.
 *
 * The caller is expected to floor the result: an empty list means the scan
 * stopped matching, never that the repo publishes nothing.
 *
 * @param {string} root - repository root
 * @returns {string[]}
 */
export function publishablePackages(root) {
  return readdirSync(join(root, "packages"))
    .map((dir) => join("packages", dir))
    .filter((dir) => {
      const manifest = join(root, dir, "package.json");
      if (!existsSync(manifest)) return false;
      try {
        return readManifest(manifest).private !== true;
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Pack one package the way a release does and hand the tarball to `fn`.
 *
 * Packing rather than reading `dist/` is the whole point at both call sites:
 * `files`, `.npmignore` and `prepack` all sit between the two, and every
 * "we shipped the wrong thing" bug lives in that gap. `--pack-destination` keeps
 * the `.tgz` out of the package directory, so a failed run cannot leave a stray
 * archive for the next `files` glob to pick up, and the scratch directory is
 * removed on every path.
 *
 * @template T
 * @param {string} packageDir - absolute path of the package to pack
 * @param {(ctx: { tarball: string, workDir: string }) => T} fn
 * @returns {T}
 */
export function withPackedTarball(packageDir, fn) {
  const workDir = mkdtempSync(join(tmpdir(), "aai-pack-"));
  try {
    mkdirSync(workDir, { recursive: true });
    execFileSync("pnpm", ["pack", "--pack-destination", workDir], {
      cwd: packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const name = readdirSync(workDir).find((entry) => entry.endsWith(".tgz"));
    if (name === undefined) throw new Error(`pnpm pack produced no tarball for ${packageDir}`);
    return fn({ tarball: join(workDir, name), workDir });
  } finally {
    rmSync(workDir, { force: true, recursive: true });
  }
}

/** The `package/package.json` inside a packed tarball, read without extracting. */
export function manifestInTarball(tarball) {
  return JSON.parse(
    execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
  );
}
