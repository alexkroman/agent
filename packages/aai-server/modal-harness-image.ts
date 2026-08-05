// Copyright 2026 the AAI authors. MIT license.
/**
 * Harness-baked snapshot images (see modal-sandbox.ts for the spawn flow).
 *
 * Built at most once per (base image, harness code, toolchain) triple, in two
 * halves that fail and cache very differently:
 *
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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { App, Image, ModalClient } from "modal";
import { debug } from "./_debug-log.ts";
import { keyedMemoAsync } from "./_memo.ts";

/** Root the guest toolchain and harness live under inside the baked image. */
export const GUEST_ROOT = "/opt/aai";

/** Where the guest harness lives inside the baked image. */
export const HARNESS_REMOTE_PATH = `${GUEST_ROOT}/harness.mjs`;

/** Name the harness-baked snapshot images are published under. */
const HARNESS_IMAGE_NAME = "aai-guest-harness";

/** Budget for the one-time harness-image build (spawn + install + snapshot). */
const HARNESS_IMAGE_BUILD_TIMEOUT_MS = 10 * 60_000;

/**
 * The packages `npm install`ed into the image — everything guest builds
 * resolve at runtime: the CLI bundlers plus the workspace-facing packages a
 * scaffolded project depends on. Must stay a subset of aai-guest's own
 * `dependencies`/`devDependencies` (where the versions come from —
 * `@types/node` lives in devDependencies because sherif forbids `@types/*`
 * in a private package's dependencies).
 */
const TOOLCHAIN_PACKAGES = [
  "@alexkroman1/aai",
  "@alexkroman1/aai-cli",
  "@alexkroman1/aai-ui",
  "@tailwindcss/vite",
  "@types/node",
  // Without these, every workspace with a client.tsx fails its typecheck on
  // TS7016 ("could not find a declaration file for module 'react'") — the
  // bundlers don't care, but the typecheck gate in front of them does.
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "react",
  "react-dom",
  "tailwindcss",
  "typescript",
  "vite",
  // The starter workspace ships an agent.test.ts, so `aai test` has to find
  // a local vitest — without it the CLI falls back to `npx vitest` and pays
  // a network fetch inside the sandbox.
  "vitest",
  "zod",
] as const;

/**
 * Resolve `name@version` install specs for the toolchain from aai-guest's
 * package.json. `workspace:*` versions (the aai packages) are pinned to the
 * version installed in this checkout, so the image tracks the release the
 * server actually runs.
 */
export function resolveToolchainSpecs(): string[] {
  const require = createRequire(import.meta.url);
  const guestPkgPath = require.resolve("aai-guest/package.json");
  const guestDir = path.dirname(guestPkgPath);
  const guestPkg = JSON.parse(readFileSync(guestPkgPath, "utf-8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return TOOLCHAIN_PACKAGES.map((name) => {
    const declared = guestPkg.dependencies?.[name] ?? guestPkg.devDependencies?.[name];
    if (!declared) {
      throw new Error(`aai-guest package.json no longer declares toolchain package ${name}`);
    }
    if (!declared.startsWith("workspace:")) return `${name}@${declared}`;
    // Read the installed package's own version through aai-guest's
    // node_modules (a plain path through the pnpm symlink — the aai exports
    // map deliberately exposes no ./package.json subpath to require.resolve).
    const installed = JSON.parse(
      readFileSync(path.join(guestDir, "node_modules", name, "package.json"), "utf-8"),
    ) as { version: string };
    return `${name}@${installed.version}`;
  });
}

/**
 * The content-addressed tag one (base image, harness code, toolchain) triple
 * publishes under. Pure — this is also how a deploy records WHICH image an
 * agent was deployed against (`harness_image_tag` on the agents row), so the
 * tag computation must stay a function of exactly these inputs.
 */
export function harnessImageTag(baseTag: string, code: string, specs: string[]): string {
  const hash = createHash("sha256")
    .update(baseTag)
    .update("\0")
    .update(code)
    .update("\0")
    .update(specs.join(","))
    .digest("hex");
  return `${HARNESS_IMAGE_NAME}:${hash.slice(0, 16)}`;
}

export type HarnessImageResolver = (code: string) => Promise<Image>;

/**
 * The toolchain install as a native image LAYER.
 *
 * This used to be an `npm install` exec inside the builder sandbox, with its
 * own exit-code handling and a bounded stderr tail for the failure message.
 * `dockerfileCommands` hands the same work to Modal's image builder, which
 * caches layers by their commands — so the expensive, version-stable half of
 * the image is a cache HIT for every harness rebuild (the common case: a
 * server code change bumps the harness, not the toolchain), instead of
 * reinstalling ~15 packages every time the tag changes.
 *
 * The harness bundle itself cannot join this layer: the JS SDK's
 * `dockerfileCommands` takes commands only, with no build context, so there is
 * nothing to `COPY` a ~13 MB local file from. It is written into a sandbox
 * started from this layer and snapshotted on top — see `build`.
 *
 * Note the specs are `name@<declared range>` for third-party packages and
 * exact versions only for the aai ones (`resolveToolchainSpecs`). Modal's
 * layer cache keys on this command string, and so does the published tag, so
 * an unchanged range keeps the SAME installed tree — a new upstream release
 * inside the range does not silently appear in a rebuilt image. That is the
 * behaviour we want from a pinned, per-deploy environment; bumping a range in
 * aai-guest's package.json is what moves it.
 */
export function toolchainImage(baseImage: Image, specs: readonly string[]): Image {
  return baseImage.dockerfileCommands([
    `RUN mkdir -p ${GUEST_ROOT}`,
    // One RUN, so the install is one cached layer rather than N.
    `RUN npm install --prefix ${GUEST_ROOT} --no-audit --no-fund ${specs.join(" ")}`,
  ]);
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

  const tagFor = (code: string, specs: string[]): string => harnessImageTag(baseTag, code, specs);

  async function build(tag: string, code: string, specs: string[]): Promise<Image> {
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
    const base = await toolchainImage(baseImage, specs).build(app);
    // Only the harness file write needs a sandbox — it is a local ~13 MB
    // blob, and an image build has no context to COPY it from.
    const builder = await client.sandboxes.create(app, base, {
      command: ["sleep", "infinity"],
      timeoutMs: HARNESS_IMAGE_BUILD_TIMEOUT_MS,
      tags: { service: "aai-guest-image-build" },
    });
    try {
      await builder.filesystem.writeText(code, HARNESS_REMOTE_PATH);
      const image = await builder.snapshotFilesystem();
      await image.publish(tag);
      debug("Harness snapshot image published", { tag, toolchain: specs.length });
      return image;
    } finally {
      await builder.terminate().catch(() => undefined);
    }
  }

  // Both inputs are invariant per process — the harness code is itself
  // memoized, and the toolchain specs come from package.json files on disk —
  // so the tag is the same value every time. Computing it inside the resolver
  // meant SHA-256 over the ~12.8 MB harness bundle (13-15ms, synchronous, so
  // it stalls the event loop) plus a handful of readFileSync+JSON.parse on
  // EVERY spawn: every cold session, every studio broker call, every
  // describeBundle. Cache it by harness code instead.
  const tagMemo = new Map<string, string>();
  const tagOnce = (code: string): string => {
    let tag = tagMemo.get(code);
    if (tag === undefined) {
      tag = tagFor(code, resolveToolchainSpecs());
      tagMemo.set(code, tag);
    }
    return tag;
  };

  return (code: string): Promise<Image> => {
    const tag = tagOnce(code);
    // Re-resolving the specs in the builder costs a few readFileSync calls,
    // but only on the once-per-tag build path rather than once per spawn.
    return memo(tag, () => build(tag, code, resolveToolchainSpecs()));
  };
}
