// Copyright 2026 the AAI authors. MIT license.
/**
 * Harness-baked snapshot images (see modal-sandbox.ts for the spawn flow).
 *
 * Built at most once per (base image, harness code, toolchain) triple, in
 * halves that fail and cache very differently:
 *
 * 0. **The system packages are a native image layer too**
 *    (`systemPackagesImage`, `GUEST_SYSTEM_PACKAGES`) — `apt-get install
 *    ffmpeg`, so a workflow step can transcode and probe media. FIRST, because
 *    it is the layer that changes least: an SDK release invalidates the
 *    toolchain below it and this one stays a cache hit.
 * 1. **The toolchain is a native image LAYER** (`toolchainImage`): a
 *    `dockerfileCommands` `RUN npm install`, built by Modal's own image
 *    builder and cached by Modal on those commands. So a harness rebuild —
 *    the common case, since any server code change bumps the harness — reuses
 *    the installed toolchain instead of reinstalling ~15 packages. This
 *    replaced an `npm install` exec in the builder sandbox, with its own
 *    exit-code branch and a bounded stderr tail for the error message.
 * 2. **The harness file needs a sandbox**, because the JS SDK's
 *    `dockerfileCommands` takes commands with no build context — there is
 *    nothing to `COPY` a local ~13 MB bundle from. A throwaway sandbox
 *    started from the layer writes it, and `snapshotFilesystem` captures the
 *    result.
 *
 * The snapshot is published under a content-addressed tag so every later
 * spawn (and every other replica, across restarts) resolves it with one
 * `images.fromName` call. A new harness build, a base-image change, or a
 * toolchain version bump mints a new tag.
 *
 * ## The toolchain
 *
 * Guest sandboxes BUILD workspaces now — `workspace/deploy` and the studio's
 * `test_agent` run the aai CLI's own bundlers in-guest (see
 * aai-guest/studio-build.ts). The harness bundle keeps that toolchain
 * external, resolving it at runtime from the `node_modules` installed here,
 * next to `/opt/aai/harness.mjs`; materialized workspaces live under the
 * same root so their bare imports (`@alexkroman1/aai`, `zod`, `react`, …)
 * resolve by the normal walk-up, exactly as in a user project.
 *
 * Versions come from aai-guest's own dependency declarations (the same ones
 * the integration test's direct harness spawn resolves through the
 * workspace), with
 * `workspace:*` entries pinned to the locally installed package versions —
 * one source of truth, so the baked toolchain and the dev toolchain cannot
 * drift silently.
 *
 * This is the only harness-delivery path — a failed build fails the spawn
 * loudly; the memo is cleared so the next spawn retries (a transient
 * control-plane error must not disable sandboxing for the process lifetime).
 */

import { createHash, hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { App, Image, ModalClient, Sandbox } from "modal";
import pTimeout from "p-timeout";
import { keyedMemoAsync } from "./_memo.ts";
import { resolveHarnessPath } from "./constants.ts";
import { GUEST_ROOT, guestExecBaseEnv, HARNESS_REMOTE_PATH } from "./guest-exec-env.ts";
import { createLogger } from "./logger.ts";
import {
  GUEST_SYSTEM_PACKAGES,
  systemPackageList,
  systemPackagesImage,
} from "./modal-system-packages.ts";

const log = createLogger("modal.harness-image");

// The guest exec CONTRACT used to live here and now lives beside itself
// (`guest-exec-env.ts`, whose doc has the seam). Re-exported by name rather than
// with `export *`: every import site in the package and in the specs still reads
// these four off this module, and a named list is what keeps `noReExportAll` and
// knip able to see which of them are actually used — `GUEST_SCRATCH_DIR` is
// deliberately NOT among them, having no reader here.
export {
  GUEST_ROOT,
  guestExecBaseEnv,
  HARNESS_COMPILE_CACHE_PATH,
  HARNESS_REMOTE_PATH,
} from "./guest-exec-env.ts";

/** Name the harness-baked snapshot images are published under. */
const HARNESS_IMAGE_NAME = "aai-guest-harness";

/** Budget for the one-time harness-image build (spawn + install + snapshot). */
const HARNESS_IMAGE_BUILD_TIMEOUT_MS = 10 * 60_000;

/**
 * Budget for the compile-cache warm-up run. Generous against the ~0.5s the
 * uncached harness takes to evaluate and exit, because overrunning it only
 * costs the cache — never the build.
 */
const HARNESS_WARMUP_TIMEOUT_MS = 60_000;

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
 * EXPORTED only so `guest-image-extractors.test.ts` can compare it against what
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
 * range (the image tag and Modal's layer cache both key on these strings, so a
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
 * Two callers have to agree exactly: the resolver that PUBLISHES the image,
 * and `currentHarnessImageTag` (sandbox-vm.ts), which records the tag on the
 * agents row so a deploy pins its environment. Spelling the three calls out
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

export type HarnessImageResolver = (code: string) => Promise<Image>;

/**
 * The toolchain install as a native image LAYER.
 *
 * This used to be an `npm install` exec inside the builder sandbox, with its
 * own exit-code handling and a bounded stderr tail for the failure message.
 * `dockerfileCommands` hands the same work to Modal's image builder, which
 * caches layers by their commands — so the version-stable half of the image is
 * a cache HIT for every harness rebuild (the common case: a server code change
 * bumps the harness, not the toolchain).
 *
 * The layer installs in two steps, for the reason
 * `scripts/sync-guest-toolchain.mjs` explains at length:
 *
 * 1. `npm ci` against the COMMITTED manifest + lockfile, so the third-party
 *    tree — where nearly all the transitive surface lives — is byte-identical
 *    to what this repo tested with, whenever and wherever the layer is built.
 * 2. `npm install` of the SDK packages at exact resolved versions, which
 *    cannot be locked here: their versions change every release, and a
 *    lockfile entry needs an integrity hash that only exists post-publish.
 *
 * Both files are written by the RUN itself, gzipped and base64'd (~20 KB), not
 * COPY'd: the JS SDK's `dockerfileCommands` takes commands with no build
 * context. That is also why the ~13 MB harness bundle cannot join this layer —
 * it is written into a sandbox started from the layer and snapshotted on top
 * (see `build`).
 *
 * **Neither step runs a dependency's install scripts** (`--ignore-scripts`).
 * npm 11.19 REPORTS an unreviewed install script and then runs it anyway (the
 * skip in arborist is gated on an explicit deny), so `npm warn install-scripts
 * … not yet covered by allowScripts` was a notice about code that had already
 * executed in the build producing every tenant's guest image — and the second
 * step is unlocked by construction, so a hijacked transitive arrives there with
 * no integrity hash to fail against. Skipping is measured, not assumed, and the
 * argument (including why `--strict-allow-scripts` is worse here, and why the
 * flags stay out of {@link toolchainFingerprint}, which is pinned on agents
 * rows) is in "The snapshot image" in `packages/aai-guest/CLAUDE.md`.
 */
export function toolchainImage(
  baseImage: Image,
  sdkSpecs: readonly string[],
  lock: ToolchainLock,
): Image {
  const embed = (content: string, name: string): string =>
    // Piped through gunzip so the command stays ~20 KB rather than ~250 KB;
    // single-quoted base64 is inert to the shell (the alphabet has no quotes).
    `RUN echo '${gzipBase64(content)}' | base64 -d | gunzip > ${GUEST_ROOT}/${name}`;

  return baseImage.dockerfileCommands([
    `RUN mkdir -p ${GUEST_ROOT}`,
    embed(lock.manifest, "package.json"),
    embed(lock.lock, "package-lock.json"),
    // `npm ci` refuses to run when the two disagree, which is the check we
    // want: a hand-edited manifest fails the BUILD rather than silently
    // installing something else.
    `RUN cd ${GUEST_ROOT} && npm ci --no-audit --no-fund --ignore-scripts`,
    // The SDK packages go on top, in one RUN so they are one cached layer.
    `RUN npm install --prefix ${GUEST_ROOT} --no-audit --no-fund --ignore-scripts ${sdkSpecs.join(" ")}`,
  ]);
}

/** gzip + base64 in one step — the shell-safe form of a file in a RUN line. */
function gzipBase64(content: string): string {
  return gzipSync(Buffer.from(content, "utf-8"), { level: 9 }).toString("base64");
}

/**
 * Populate the harness's V8 compile cache inside the builder sandbox, so the
 * snapshot carries it (see {@link guestExecBaseEnv} for the measured saving).
 *
 * Runs the harness in warm-up mode — it evaluates the module and exits 0,
 * opening no server and reading no bundle. BEST-EFFORT: a failed or slow
 * warm-up must not fail the image build, because the cache is an optimization
 * and the image without it is exactly today's working image. A non-zero exit
 * is logged rather than swallowed silently, since the failure is otherwise
 * invisible — the image builds, boots, and is merely 200ms slower forever.
 */
async function warmCompileCache(builder: Sandbox): Promise<void> {
  try {
    const proc = await builder.exec(["node", HARNESS_REMOTE_PATH], {
      mode: "binary",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...guestExecBaseEnv(), AAI_GUEST_WARMUP: "1" },
    });
    const exit = await pTimeout(proc.wait(), {
      milliseconds: HARNESS_WARMUP_TIMEOUT_MS,
      message: `harness warm-up exceeded ${HARNESS_WARMUP_TIMEOUT_MS}ms`,
    });
    if (exit !== 0) log.debug("Harness compile-cache warm-up exited non-zero", { exit });
  } catch (err) {
    log.debug("Harness compile-cache warm-up failed; image will boot uncached", {
      error: errorMessage(err),
    });
  }
}

/** Build the memoizing (code → published snapshot Image) resolver. */
export function createHarnessImageResolver(deps: {
  client: ModalClient;
  app: App;
  baseTag: string;
  baseImage: Image;
}): HarnessImageResolver {
  const { client, app, baseTag, baseImage } = deps;
  const memo = keyedMemoAsync<Image>();

  async function build(tag: string, code: string): Promise<Image> {
    try {
      // Another replica (or a previous run of this one) may have published it.
      return await client.images.fromName(tag);
    } catch {
      // Not published yet — build it below.
    }
    // The toolchain is a cached image layer (see `toolchainImage`); Modal
    // builds it if these exact commands have never been built, and hands back
    // the cached layer otherwise. Network stays on for the npm registry; no
    // tenant code runs in an image build.
    const base = await toolchainImage(
      systemPackagesImage(baseImage, GUEST_SYSTEM_PACKAGES),
      resolveSdkSpecs(),
      readToolchainLock(),
    ).build(app);
    // Only the harness file write needs a sandbox — it is a local ~13 MB
    // blob, and an image build has no context to COPY it from.
    const builder = await client.sandboxes.create(app, base, {
      command: ["sleep", "infinity"],
      timeoutMs: HARNESS_IMAGE_BUILD_TIMEOUT_MS,
      tags: { service: "aai-guest-image-build" },
    });
    try {
      await builder.filesystem.writeText(code, HARNESS_REMOTE_PATH);
      await warmCompileCache(builder);
      const image = await builder.snapshotFilesystem();
      await image.publish(tag);
      log.debug("Harness snapshot image published", { tag });
      return image;
    } finally {
      await builder.terminate().catch(() => undefined);
    }
  }

  // The tag's inputs are invariant per process — the harness code is itself
  // memoized, and the specs and lockfile come from files on disk — so it is
  // the same value every time. Computing it per call meant SHA-256 over the
  // ~12.8 MB harness bundle (13-15ms, synchronous, so it stalls the event
  // loop) plus a handful of readFileSync+JSON.parse on EVERY spawn: every cold
  // session and every studio broker call. Cache it by
  // harness code instead.
  const tagMemo = new Map<string, string>();
  const tagOnce = (code: string): string => {
    let tag = tagMemo.get(code);
    if (tag === undefined) {
      tag = localHarnessImageTag(baseTag, code);
      tagMemo.set(code, tag);
    }
    return tag;
  };

  return (code: string): Promise<Image> => {
    const tag = tagOnce(code);
    return memo(tag, () => build(tag, code));
  };
}
