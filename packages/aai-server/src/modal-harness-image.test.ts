// Copyright 2026 the AAI authors. MIT license.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { App, Image, ModalClient } from "modal";
import { describe, expect, test, vi } from "vitest";
import { resolveHarnessPath } from "./constants.ts";
import {
  createHarnessImageResolver,
  GUEST_ROOT,
  guestExecBaseEnv,
  HARNESS_COMPILE_CACHE_PATH,
  HARNESS_REMOTE_PATH,
  harnessImageTag,
  localHarnessImageTag,
  readToolchainLock,
  resolveSdkSpecs,
  toolchainFingerprint,
  toolchainImage,
} from "./modal-harness-image.ts";
import { fakeModalImage as fakeImage } from "./test-utils.ts";

// Everything except the digest primitive stays real. `createHash` is the one
// observable that says whether the resolver re-paid the SHA-256 over the ~13 MB
// harness — see "computes the tag once per distinct code" below.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

describe("harnessImageTag", () => {
  test("is a pure function of base image, harness code, and toolchain", () => {
    const tag = harnessImageTag("node:24-slim", "harness", ["a@1"]);
    expect(tag).toBe(harnessImageTag("node:24-slim", "harness", ["a@1"]));
    expect(tag).toMatch(/^aai-guest-harness:[0-9a-f]{16}$/);
  });

  // Each input is recorded on an agent's row as `harness_image_tag`, so a
  // change in any of them must mint a new tag — otherwise a deployed bundle
  // would silently resolve a different environment than it was tested on.
  test("changes when any input changes", () => {
    const base = harnessImageTag("node:24-slim", "harness", ["a@1"]);
    expect(harnessImageTag("node:26-slim", "harness", ["a@1"])).not.toBe(base);
    expect(harnessImageTag("node:24-slim", "harness2", ["a@1"])).not.toBe(base);
    expect(harnessImageTag("node:24-slim", "harness", ["a@2"])).not.toBe(base);
  });
});

describe("resolveSdkSpecs", () => {
  /**
   * Exact versions, not declared ranges. Both the image tag and Modal's layer
   * cache key on these strings, so a range would let one `harness_image_tag`
   * mean two different trees — the opposite of the per-deploy environment
   * pinning the tag exists to provide.
   */
  test("pins each SDK package to the exact installed version", () => {
    const specs = resolveSdkSpecs();
    expect(specs.length).toBeGreaterThan(0);
    // Soft: a bad resolution usually hits every SDK package at once, and the
    // whole list is what says whether the derivation or one package broke.
    for (const spec of specs) {
      expect.soft(spec).toMatch(/^@alexkroman1\/[^@]+@\d+\.\d+\.\d+/);
      // Neither a range nor an unresolved workspace protocol — npm in the
      // guest can install neither reproducibly.
      expect.soft(spec).not.toContain("workspace:");
      expect.soft(spec).not.toMatch(/@[\^~*]/);
    }
  });
});

describe("readToolchainLock", () => {
  test("reads the committed manifest and lockfile", () => {
    const lock = readToolchainLock();
    const manifest = JSON.parse(lock.manifest) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies).toBeDefined();
    // The SDK packages are installed separately — they cannot be locked (a
    // lockfile entry needs an integrity hash that only exists post-publish).
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      expect.soft(name).not.toMatch(/^@alexkroman1\//);
    }
    const parsed = JSON.parse(lock.lock) as { lockfileVersion?: number };
    expect(parsed.lockfileVersion).toBeGreaterThanOrEqual(2);
  });

  test("every locked dependency is pinned exactly", () => {
    const manifest = JSON.parse(readToolchainLock().manifest) as {
      dependencies: Record<string, string>;
    };
    // Soft, and labelled: a hand-edited manifest tends to loosen more than one
    // pin, and the failure has to name which package it is.
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      expect.soft(version, name).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  /**
   * Everything above is read relative to the aai-guest package root, which
   * this module locates two different ways (see `guestPackageDir`). The
   * fallback — the one the DEPLOYED, bundled build takes, where
   * `createRequire` cannot see `aai-guest` at all — derives that root from the
   * harness path by walking up twice. That only holds while the `./harness`
   * export stays exactly one directory deep, and moving it would break the
   * production path alone: every test and every local run resolves through
   * `createRequire` and would stay green.
   */
  test("the harness export is one directory below the package root", () => {
    const exports = JSON.parse(
      readFileSync(
        path.join(path.dirname(path.dirname(resolveHarnessPath())), "package.json"),
        "utf-8",
      ),
    ) as { name?: string; exports?: Record<string, string> };
    expect(exports.name).toBe("aai-guest");
    expect(exports.exports?.["./harness"]).toMatch(/^\.\/[^/]+\/[^/]+$/);
  });
});

describe("toolchainFingerprint", () => {
  // The manifest names direct versions; the lockfile names the whole resolved
  // tree. Hashing the lock is what makes a purely transitive change mint a new
  // tag instead of quietly reusing one.
  test("changes when the lockfile changes, even at identical direct versions", () => {
    const specs = ["@alexkroman1/aai@5.7.0"];
    const a = toolchainFingerprint(specs, { manifest: "{}", lock: '{"a":1}' }, ["ffmpeg"]);
    const b = toolchainFingerprint(specs, { manifest: "{}", lock: '{"a":2}' }, ["ffmpeg"]);
    expect(a).not.toEqual(b);
    expect(harnessImageTag("node:24-slim", "code", a)).not.toBe(
      harnessImageTag("node:24-slim", "code", b),
    );
  });

  test("ignores the manifest, which the lockfile already covers", () => {
    const specs = ["@alexkroman1/aai@5.7.0"];
    expect(toolchainFingerprint(specs, { manifest: "{}", lock: "L" }, ["ffmpeg"])).toEqual(
      toolchainFingerprint(specs, { manifest: '{"different":true}', lock: "L" }, ["ffmpeg"]),
    );
  });

  /**
   * The failure this covers is the silent one: the apt layer is part of the
   * environment a deploy is pinned to, so a package joining it without moving
   * the fingerprint leaves every already-published snapshot resolvable under
   * its old tag — a guest that boots fine and lacks the binary a step calls.
   */
  test("changes when the system packages change", () => {
    const specs = ["@alexkroman1/aai@5.7.0"];
    const lock = { manifest: "{}", lock: "L" };
    expect(toolchainFingerprint(specs, lock, ["ffmpeg"])).not.toEqual(
      toolchainFingerprint(specs, lock, []),
    );
    expect(toolchainFingerprint(specs, lock, ["ffmpeg"])).not.toEqual(
      toolchainFingerprint(specs, lock, ["ffmpeg", "imagemagick"]),
    );
  });

  // Sorted, so the DECLARATION order is not an input: reordering the list
  // would otherwise mint a tag for an image that is byte-identical.
  test("is insensitive to the order the packages are declared in", () => {
    const specs = ["@alexkroman1/aai@5.7.0"];
    const lock = { manifest: "{}", lock: "L" };
    expect(toolchainFingerprint(specs, lock, ["ffmpeg", "sox"])).toEqual(
      toolchainFingerprint(specs, lock, ["sox", "ffmpeg"]),
    );
  });
});

describe("toolchainImage", () => {
  const LOCK = { manifest: '{"dependencies":{"zod":"4.4.3"}}', lock: '{"lockfileVersion":3}' };

  test("installs the locked tree with npm ci, then the SDK on top", () => {
    const image = fakeImage();
    toolchainImage(image, ["@alexkroman1/aai@5.7.0"], LOCK);
    const layer = image.commands[0] ?? [];

    // npm ci (not install) is what makes the third-party tree byte-identical
    // to the committed lockfile, and it refuses to run when the manifest and
    // lockfile disagree — a hand-edited manifest fails the BUILD.
    const ci = layer.filter((line) => line.includes("npm ci"));
    expect(ci).toHaveLength(1);
    expect(ci[0]).toContain(`cd ${GUEST_ROOT}`);

    // The SDK packages go on separately, exactly pinned.
    const installs = layer.filter((line) => line.includes("npm install"));
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain("@alexkroman1/aai@5.7.0");

    // Ordering is load-bearing: npm ci wipes node_modules, so an SDK install
    // before it would be erased.
    expect(layer.indexOf(ci[0] ?? "")).toBeLessThan(layer.indexOf(installs[0] ?? ""));
  });

  /**
   * npm 11.19 WARNS about unreviewed install scripts and runs them anyway (the
   * skip in arborist is gated on an explicit deny), so the flag is the only
   * thing standing between a hijacked transitive and code execution in the
   * build that produces every tenant's guest image. It is asserted per COMMAND
   * rather than over the joined layer: the unlocked SDK install is the one that
   * matters most, and a check on the layer as a whole would pass with the flag
   * on `npm ci` alone.
   */
  test("neither install step runs a dependency's install scripts", () => {
    const image = fakeImage();
    toolchainImage(image, ["@alexkroman1/aai@5.7.0"], LOCK);
    const layer = image.commands[0] ?? [];

    const installs = layer.filter(
      (line) => line.includes("npm ci") || line.includes("npm install"),
    );
    expect(installs).toHaveLength(2);
    for (const line of installs) {
      expect.soft(line, line).toContain("--ignore-scripts");
    }
  });

  /**
   * `dockerfileCommands` carries no build context, so both files are written
   * by the RUN itself. Gzip keeps the command ~20 KB rather than ~250 KB.
   */
  test("embeds the manifest and lockfile as compressed, shell-safe payloads", () => {
    const image = fakeImage();
    toolchainImage(image, ["@alexkroman1/aai@5.7.0"], LOCK);
    const layer = image.commands[0] ?? [];
    const embeds = layer.filter((line) => line.includes("base64 -d"));
    expect(embeds).toHaveLength(2);
    expect(embeds.some((line) => line.endsWith(`${GUEST_ROOT}/package.json`))).toBe(true);
    expect(embeds.some((line) => line.endsWith(`${GUEST_ROOT}/package-lock.json`))).toBe(true);
    for (const line of embeds) {
      // Base64's alphabet contains no quotes, so the single-quoted payload is
      // inert to the shell — no escaping to get wrong.
      const payload = /'([^']*)'/.exec(line)?.[1] ?? "";
      expect.soft(payload).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect.soft(payload.length).toBeGreaterThan(0);
    }
  });

  test("round-trips the embedded payloads", () => {
    const image = fakeImage();
    toolchainImage(image, [], LOCK);
    const layer = image.commands[0] ?? [];
    const decode = (suffix: string): string => {
      const line = layer.find((l) => l.endsWith(suffix)) ?? "";
      const payload = /'([^']*)'/.exec(line)?.[1] ?? "";
      return gunzipSync(Buffer.from(payload, "base64")).toString("utf-8");
    };
    expect(decode("package.json")).toBe(LOCK.manifest);
    expect(decode("package-lock.json")).toBe(LOCK.lock);
  });
});

describe("createHarnessImageResolver", () => {
  /**
   * A Modal double recording what the build path did — one mutable state
   * object, so assertions observe the resolver's effects.
   */
  function make(
    opts: {
      publishedTags?: Set<string>;
      failSnapshot?: boolean;
      /** Warm-up outcome: a non-zero exit, or a rejecting exec. */
      warmupExit?: number;
      failWarmup?: boolean;
    } = {},
  ) {
    const publishedTags = opts.publishedTags ?? new Set<string>();
    const state = {
      published: [] as string[],
      writes: [] as { data: string; path: string }[],
      created: 0,
      terminated: 0,
      fromNameCalls: [] as string[],
      builds: 0,
      /** Every exec the build ran, in order, with its env. */
      execs: [] as { command: string[]; env: Record<string, string> }[],
      /** Ordering probe: was the snapshot taken after the warm-up exec? */
      snapshotAfterExecs: -1,
      /** Every `dockerfileCommands` layer the build stacked, in order. */
      layers: [] as string[][],
    };
    const snapshot = {
      publish: (tag: string) => {
        state.published.push(tag);
        publishedTags.add(tag);
        return Promise.resolve();
      },
    } as unknown as Image;
    const baseImage = {
      dockerfileCommands: (next: string[]) => {
        state.layers.push(next);
        return baseImage;
      },
      build: () => {
        state.builds++;
        return Promise.resolve(baseImage);
      },
    } as unknown as Image;
    const client = {
      images: {
        fromName: (tag: string) => {
          state.fromNameCalls.push(tag);
          return publishedTags.has(tag)
            ? Promise.resolve(baseImage)
            : Promise.reject(new Error("not found"));
        },
      },
      sandboxes: {
        create: () => {
          state.created++;
          return Promise.resolve({
            filesystem: {
              writeText: (data: string, path: string) => {
                state.writes.push({ data, path });
                return Promise.resolve();
              },
            },
            exec: (command: string[], params: { env?: Record<string, string> }) => {
              state.execs.push({ command, env: params.env ?? {} });
              return opts.failWarmup
                ? Promise.reject(new Error("exec failed"))
                : Promise.resolve({ wait: () => Promise.resolve(opts.warmupExit ?? 0) });
            },
            snapshotFilesystem: () => {
              state.snapshotAfterExecs = state.execs.length;
              return opts.failSnapshot
                ? Promise.reject(new Error("snapshot failed"))
                : Promise.resolve(snapshot);
            },
            terminate: () => {
              state.terminated++;
              return Promise.resolve();
            },
          });
        },
      },
    } as unknown as ModalClient;
    const resolve = createHarnessImageResolver({
      client,
      app: {} as App,
      baseTag: "node:24-slim",
      baseImage,
    });
    return { state, resolve };
  }

  const tagFor = (code: string): string => localHarnessImageTag("node:24-slim", code);

  test("reuses a published tag without building anything", async () => {
    const { state, resolve } = make({ publishedTags: new Set([tagFor("harness code")]) });
    await resolve("harness code");
    // Another replica already published it: no sandbox, no image build.
    expect(state.created).toBe(0);
    expect(state.builds).toBe(0);
    expect(state.published).toEqual([]);
  });

  test("builds the toolchain layer, writes the harness, publishes the snapshot", async () => {
    const { state, resolve } = make();
    await resolve("harness code");
    // The toolchain is an image layer Modal caches; only the harness write
    // needs a sandbox, because an image build has no context to COPY from.
    expect(state.builds).toBe(1);
    expect(state.writes).toEqual([{ data: "harness code", path: HARNESS_REMOTE_PATH }]);
    expect(state.published).toEqual([tagFor("harness code")]);
    // The builder is throwaway — leaving it running bills a sandbox.
    expect(state.terminated).toBe(1);
  });

  /**
   * The apt layer is FIRST on purpose. Modal caches layers by their commands
   * in order, and the toolchain below it is invalidated by every SDK release —
   * stacked the other way round, each release would reinstall ffmpeg too.
   */
  test("stacks the system packages under the toolchain", async () => {
    const { state, resolve } = make();
    await resolve("harness code");
    const flat = state.layers.map((layer) => layer.join("\n"));
    const apt = flat.findIndex((layer) => layer.includes("apt-get install"));
    const npm = flat.findIndex((layer) => layer.includes("npm ci"));
    expect(apt).toBeGreaterThanOrEqual(0);
    expect(npm).toBeGreaterThanOrEqual(0);
    expect(apt).toBeLessThan(npm);
  });

  test("terminates the builder even when the snapshot fails", async () => {
    const { state, resolve } = make({ failSnapshot: true });
    await expect(resolve("harness code")).rejects.toThrow("snapshot failed");
    expect(state.terminated).toBe(1);
  });

  test("memoizes per harness code, so concurrent spawns build once", async () => {
    const { state, resolve } = make();
    await Promise.all([resolve("harness code"), resolve("harness code"), resolve("harness code")]);
    expect(state.created).toBe(1);
    expect(state.published).toHaveLength(1);
  });

  test("warms the compile cache into the snapshot, before taking it", async () => {
    const { state, resolve } = make();
    await resolve("harness code");
    // One exec: the harness in warm-up mode, pointed at the cache path the
    // guest exec env will name. Without this the image snapshots an EMPTY
    // cache and every guest boot pays ~200ms of parse+compile forever — and
    // nothing would report it, which is why the ordering is asserted too.
    expect(state.execs).toEqual([
      {
        command: ["node", HARNESS_REMOTE_PATH],
        env: { ...guestExecBaseEnv(), AAI_GUEST_WARMUP: "1" },
      },
    ]);
    expect(state.execs[0]?.env.NODE_COMPILE_CACHE).toBe(HARNESS_COMPILE_CACHE_PATH);
    // The cache has to be populated BEFORE the filesystem is captured.
    expect(state.snapshotAfterExecs).toBe(1);
  });

  test("still publishes when the warm-up exec rejects", async () => {
    const { state, resolve } = make({ failWarmup: true });
    await resolve("harness code");
    // Best-effort: the cache is an optimization, and an image without it is
    // exactly today's working image. Failing the build here would take the
    // whole platform's spawning down for a performance tweak.
    expect(state.published).toEqual([tagFor("harness code")]);
  });

  test("still publishes when the warm-up exits non-zero", async () => {
    const { state, resolve } = make({ warmupExit: 1 });
    await resolve("harness code");
    expect(state.published).toEqual([tagFor("harness code")]);
  });

  test("computes the tag once per distinct code, not once per spawn", async () => {
    const { resolve } = make();
    await resolve("harness code");

    // The cost the memo exists to avoid is the STREAMING SHA-256 over the
    // ~13 MB harness inside `harnessImageTag` — 13-15ms, synchronous, on every
    // spawn. Spying the global `JSON.parse` stood here, and was neither
    // necessary nor sufficient: a resolver that stopped memoizing the digest
    // but happened not to re-read a manifest passed, and any unrelated parse on
    // the path failed. `createHash` names the actual expense.
    const digest = vi.mocked(createHash);
    digest.mockClear();
    await resolve("harness code");
    expect(digest).not.toHaveBeenCalled();

    // ...and the memo is per CODE, not a blanket "compute once": a different
    // harness has to mint its own tag, or a redeploy would resolve the previous
    // build's image.
    await resolve("other harness code");
    expect(digest).toHaveBeenCalled();
  });
});
