// Copyright 2026 the AAI authors. MIT license.
/**
 * Harness-baked snapshot images (see modal-sandbox.ts for the spawn flow).
 *
 * Built at most once per (base image, harness code, toolchain) triple: a
 * throwaway builder sandbox writes the harness, `npm install`s the build
 * toolchain next to it, its filesystem is snapshotted, and the resulting
 * Image is published under a content-addressed tag so every later spawn
 * (and every other replica, across restarts) resolves it with one
 * `images.fromName` call. A new harness build, a base-image change, or a
 * toolchain version bump mints a new tag.
 *
 * ## The toolchain
 *
 * Guest sandboxes BUILD workspaces now — `workspace/build` and the studio's
 * `test_agent` run the aai CLI's own bundlers in-guest (see
 * aai-guest/studio-build.ts). The harness bundle keeps that toolchain
 * external, resolving it at runtime from the `node_modules` installed here,
 * next to `/opt/aai/harness.mjs`; materialized workspaces live under the
 * same root so their bare imports (`@alexkroman1/aai`, `zod`, `react`, …)
 * resolve by the normal walk-up, exactly as in a user project.
 *
 * Versions come from aai-guest's own dependency declarations (the same ones
 * dev-mode subprocess guests resolve through the workspace), with
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

/** Root the guest toolchain and harness live under inside the baked image. */
export const GUEST_ROOT = "/opt/aai";

/** Where the guest harness lives inside the baked image. */
export const HARNESS_REMOTE_PATH = `${GUEST_ROOT}/harness.mjs`;

/** Name the harness-baked snapshot images are published under. */
const HARNESS_IMAGE_NAME = "aai-guest-harness";

/** Budget for the one-time harness-image build (spawn + install + snapshot). */
const HARNESS_IMAGE_BUILD_TIMEOUT_MS = 10 * 60_000;

/** Stderr tail attached to a failed toolchain install. */
const MAX_INSTALL_STDERR = 4000;

/**
 * The packages `npm install`ed into the image — everything guest builds
 * resolve at runtime: the CLI bundlers plus the workspace-facing packages a
 * scaffolded project depends on. Must stay a subset of aai-guest's own
 * `dependencies` (where the versions come from).
 */
const TOOLCHAIN_PACKAGES = [
  "@alexkroman1/aai",
  "@alexkroman1/aai-cli",
  "@alexkroman1/aai-ui",
  "@tailwindcss/vite",
  "@vitejs/plugin-react",
  "react",
  "react-dom",
  "tailwindcss",
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
  };
  return TOOLCHAIN_PACKAGES.map((name) => {
    const declared = guestPkg.dependencies?.[name];
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

export type HarnessImageResolver = (code: string) => Promise<Image>;

/** Drain a stream into a bounded string (stderr tails for error messages). */
async function drainTail(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    out = (out + decoder.decode(chunk, { stream: true })).slice(-cap);
  }
  return out;
}

/** Build the memoizing (code → published snapshot Image) resolver. */
export function createHarnessImageResolver(deps: {
  client: ModalClient;
  app: App;
  baseTag: string;
  baseImage: Image;
}): HarnessImageResolver {
  const { client, app, baseTag, baseImage } = deps;
  const memo = new Map<string, Promise<Image>>();

  function tagFor(code: string, specs: string[]): string {
    const hash = createHash("sha256")
      .update(baseTag)
      .update("\0")
      .update(code)
      .update("\0")
      .update(specs.join(","))
      .digest("hex");
    return `${HARNESS_IMAGE_NAME}:${hash.slice(0, 16)}`;
  }

  async function build(tag: string, code: string, specs: string[]): Promise<Image> {
    try {
      // Another replica (or a previous run of this one) may have published it.
      return await client.images.fromName(tag);
    } catch {
      // Not published yet — build it below.
    }
    // Network stays ON: the toolchain install below needs the npm registry.
    // The builder runs no tenant code — only the harness file write and npm.
    const builder = await client.sandboxes.create(app, baseImage, {
      command: ["sleep", "infinity"],
      timeoutMs: HARNESS_IMAGE_BUILD_TIMEOUT_MS,
      tags: { service: "aai-guest-image-build" },
    });
    try {
      await builder.filesystem.writeText(code, HARNESS_REMOTE_PATH);
      const proc = await builder.exec(
        ["npm", "install", "--prefix", GUEST_ROOT, "--no-audit", "--no-fund", ...specs],
        { mode: "binary", stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, , exitCode] = await Promise.all([
        drainTail(proc.stderr, MAX_INSTALL_STDERR),
        drainTail(proc.stdout, MAX_INSTALL_STDERR),
        proc.wait(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`Guest toolchain install failed (exit ${exitCode}): ${stderr.trim()}`);
      }
      const image = await builder.snapshotFilesystem();
      await image.publish(tag);
      debug("Harness snapshot image published", { tag, toolchain: specs.length });
      return image;
    } finally {
      await builder.terminate().catch(() => undefined);
    }
  }

  return (code: string): Promise<Image> => {
    const specs = resolveToolchainSpecs();
    const tag = tagFor(code, specs);
    let pending = memo.get(tag);
    if (!pending) {
      pending = build(tag, code, specs).catch((err: unknown) => {
        memo.delete(tag);
        throw err;
      });
      memo.set(tag, pending);
    }
    return pending;
  };
}
