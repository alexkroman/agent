// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest harness image's IDENTITY: the content-addressed tag one
 * (base image, harness code, toolchain) triple publishes under, and the
 * toolchain inputs that tag tracks.
 *
 * The image itself is built by `packages/aai-server/guest-image.Dockerfile`
 * (`scripts/build-guest-image.mjs`) and pulled from a registry
 * (`guest/image-source.ts`). This module is what both halves agree on: the
 * build script imports `localHarnessImageTag` to name what it pushes, and a
 * deploy records the same tag on its agents row to pin its environment.
 *
 * ## The toolchain
 *
 * Guest sandboxes BUILD workspaces — `workspace/deploy` and the studio's
 * `test_agent` run the aai CLI's own bundlers in-guest (see
 * aai-guest/studio-build.ts). The harness bundle keeps that toolchain
 * external, resolving it at runtime from the `node_modules` installed next to
 * `/opt/aai/harness.mjs`.
 *
 * Versions come from aai-guest's own dependency declarations, with
 * `workspace:*` entries pinned to the locally installed package versions —
 * one source of truth, so the baked toolchain and the dev toolchain cannot
 * drift silently.
 */

import { createHash, hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveHarnessPath } from "../constants.ts";
import { GUEST_SYSTEM_PACKAGES, systemPackageList } from "./system-packages.ts";

/** Name the harness images are published under. */
const HARNESS_IMAGE_NAME = "aai-guest-harness";

/**
 * The SDK packages installed into the image on top of the locked toolchain.
 *
 * These are the ones that CANNOT be locked: their versions change with every
 * release, and a lockfile entry needs an integrity hash that only exists once
 * the version is published — which happens after the commit that bumps it. So
 * they are installed at exact resolved versions, and their own dependencies
 * (the provider SDKs) resolve at install time. See
 * `scripts/sync-guest-toolchain.mjs` for the full reasoning and for the
 * third-party half, which IS locked.
 *
 * EXPORTED only so `guest/image-extractors.test.ts` can compare it against what
 * `scripts/build-guest-image-extract.mjs` reads back out of this file's source.
 * Nothing else may import it — the scripts read the source text, since they are
 * plain `.mjs` with no TypeScript loader, and that spec is the only thing that
 * can see the two disagree.
 */
export const SDK_PACKAGES = [
  "@alexkroman1/aai",
  "@alexkroman1/aai-cli",
  "@alexkroman1/aai-runtime",
  "@alexkroman1/aai-ui",
] as const;

/** The committed toolchain manifest + lockfile the image installs with `npm ci`. */
export type ToolchainLock = {
  /** `toolchain/package.json` contents, verbatim. */
  manifest: string;
  /** `toolchain/package-lock.json` contents, verbatim. */
  lock: string;
};

/**
 * The aai-guest package root — the anchor for everything read off disk here.
 *
 * Two resolutions, because this module has two module identities. Run from
 * source (dev, tests, the subprocess backend) it sits inside `aai-server`,
 * whose `node_modules` links `aai-guest`, so `createRequire` answers directly.
 * BUNDLED into the service entry — which is how every deployment runs it, see
 * `packages/aai-studio-server/tsdown.config.ts` — `import.meta.url` is
 * `packages/aai-studio-server/dist/index.mjs`, and pnpm's strict layout has no
 * `aai-guest` above it: the require throws, and the harness image can never be
 * built. So the fallback anchors on the HARNESS path instead
 * (`<root>/dist/harness.mjs` — the `aai-guest/harness` export), which the
 * deploy image sets explicitly and which is the same package by construction.
 *
 * The fallback VERIFIES the package it lands on rather than trusting the
 * layout: `GUEST_HARNESS_PATH` promises only "a built harness.mjs", so an
 * operator pointing it somewhere else must fail here by name and not by a
 * confusing missing-lockfile error two calls later.
 */
function guestPackageDir(): string {
  // Kept as a named `require` rather than inlined: it is also how knip sees
  // that aai-server depends on aai-guest at all (nothing here imports it), and
  // an inlined `createRequire(...).resolve(...)` reads to it as an unused
  // dependency — which `pnpm check:knip` then offers to remove.
  const require = createRequire(import.meta.url);
  try {
    return path.dirname(require.resolve("aai-guest/package.json"));
  } catch (err) {
    const dir = path.dirname(path.dirname(resolveHarnessPath()));
    let name: string | undefined;
    try {
      name = (
        JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")) as { name?: string }
      ).name;
    } catch {
      // Reported as the wrong-package error below — the path is the diagnosis.
    }
    if (name !== "aai-guest") {
      throw new Error(
        "cannot locate the aai-guest package: it does not resolve from this module, and " +
          `the harness path points at ${dir}, which is not it — set GUEST_HARNESS_PATH to ` +
          "the aai-guest package's own dist/harness.mjs",
        { cause: err },
      );
    }
    return dir;
  }
}

/**
 * Read the committed toolchain lockfile.
 *
 * Absence is a hard failure, not a fallback to an unlocked install: silently
 * resolving the toolchain fresh is exactly the nondeterminism the lockfile
 * exists to remove, and it would be invisible — the image would build fine
 * and merely contain a different tree than the one this server was tested
 * against.
 */
export function readToolchainLock(): ToolchainLock {
  const dir = path.join(guestPackageDir(), "toolchain");
  const read = (name: string): string => {
    const file = path.join(dir, name);
    try {
      return readFileSync(file, "utf-8");
    } catch (err) {
      throw new Error(
        `guest toolchain ${name} is missing at ${file} — run node scripts/sync-guest-toolchain.mjs`,
        { cause: err },
      );
    }
  };
  return { manifest: read("package.json"), lock: read("package-lock.json") };
}

/**
 * Resolve `name@version` specs for the SDK packages — EXACT versions, read
 * from what this checkout installed.
 *
 * Not the declared `workspace:*` protocol (npm cannot install it) and not a
 * range (the image tag keys on these strings, so a
 * range would let one `harness_image_tag` mean two different trees).
 */
export function resolveSdkSpecs(): string[] {
  const guestDir = guestPackageDir();
  const guestPkgPath = path.join(guestDir, "package.json");
  const guestPkg = JSON.parse(readFileSync(guestPkgPath, "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return SDK_PACKAGES.map((name) => {
    const declared = guestPkg.dependencies?.[name] ?? guestPkg.devDependencies?.[name];
    if (!declared) {
      throw new Error(`aai-guest package.json no longer declares SDK package ${name}`);
    }
    // Read the installed package's own version through aai-guest's
    // node_modules (a plain path through the pnpm symlink — the aai exports
    // map deliberately exposes no ./package.json subpath to require.resolve).
    const installedPath = path.join(guestDir, "node_modules", name, "package.json");
    let installed: { version?: string };
    try {
      installed = JSON.parse(readFileSync(installedPath, "utf-8")) as { version?: string };
    } catch (err) {
      throw new Error(
        `SDK package ${name} is declared by aai-guest but not installed at ${installedPath} — ` +
          "run pnpm install before building a guest image",
        { cause: err },
      );
    }
    if (typeof installed.version !== "string") {
      throw new Error(`SDK package ${name} has no version in ${installedPath}`);
    }
    return `${name}@${installed.version}`;
  });
}

/**
 * Everything about the toolchain the image tag must track: the exact SDK
 * specs, plus the LOCKFILE's content hash.
 *
 * Hashing the lockfile rather than the manifest is the point — the manifest
 * names direct versions, the lockfile names the whole resolved tree, so a
 * transitive change that leaves every direct version alone still mints a new
 * tag instead of quietly reusing one.
 */
export function toolchainFingerprint(
  specs: string[],
  lock: ToolchainLock,
  systemPackages: readonly string[],
): string[] {
  return [
    ...specs,
    `lock:${hash("sha256", lock.lock)}`,
    `apt:${systemPackageList(systemPackages)}`,
  ];
}

/**
 * The content-addressed tag one (base image, harness code, toolchain) triple
 * publishes under. Pure — this is also how a deploy records WHICH image an
 * agent was deployed against (`harness_image_tag` on the agents row), so the
 * tag computation must stay a function of exactly these inputs.
 *
 * Deliberately the STREAMING `createHash` rather than the one-shot
 * `crypto.hash` every other digest here uses: the one-shot form takes a single
 * input, so feeding it these three parts would mean joining them into one
 * string — a second ~13 MB allocation for no gain, since at this size the
 * digest itself dominates. The separator bytes must stay exactly as they are;
 * this tag is recorded on agents rows as a per-deploy environment pin, so any
 * change to the hashed byte stream makes every existing pin resolve to
 * nothing and fails the spawn of every already-deployed agent.
 */
export function harnessImageTag(baseTag: string, code: string, toolchain: string[]): string {
  const digest = createHash("sha256")
    .update(baseTag)
    .update("\0")
    .update(code)
    .update("\0")
    .update(toolchain.join(","))
    .digest("hex");
  return `${HARNESS_IMAGE_NAME}:${digest.slice(0, 16)}`;
}

/**
 * {@link harnessImageTag} against THIS checkout's toolchain — the recipe every
 * tag site needs, in one place.
 *
 * Two callers have to agree exactly: `scripts/build-guest-image.mjs`, which
 * PUBLISHES the image under it, and `currentHarnessImageTag` (sandbox/vm.ts),
 * which records the tag on the agents row so a deploy pins its environment. Spelling the three calls out
 * twice is how a future tag input gets added to one of them only — and the
 * symptom would be a pin that resolves to nothing, failing every spawn of an
 * already-deployed agent.
 */
export function localHarnessImageTag(baseTag: string, code: string): string {
  return harnessImageTag(
    baseTag,
    code,
    toolchainFingerprint(resolveSdkSpecs(), readToolchainLock(), GUEST_SYSTEM_PACKAGES),
  );
}
