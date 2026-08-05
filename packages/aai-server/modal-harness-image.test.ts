// Copyright 2026 the AAI authors. MIT license.

import { gunzipSync } from "node:zlib";
import type { App, Image, ModalClient } from "modal";
import { describe, expect, test, vi } from "vitest";
import {
  createHarnessImageResolver,
  GUEST_ROOT,
  HARNESS_REMOTE_PATH,
  harnessImageTag,
  localHarnessImageTag,
  readToolchainLock,
  resolveSdkSpecs,
  toolchainFingerprint,
  toolchainImage,
} from "./modal-harness-image.ts";

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
    for (const spec of specs) {
      expect(spec).toMatch(/^@alexkroman1\/[^@]+@\d+\.\d+\.\d+/);
      // Neither a range nor an unresolved workspace protocol — npm in the
      // guest can install neither reproducibly.
      expect(spec).not.toContain("workspace:");
      expect(spec).not.toMatch(/@[\^~*]/);
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
      expect(name).not.toMatch(/^@alexkroman1\//);
    }
    const parsed = JSON.parse(lock.lock) as { lockfileVersion?: number };
    expect(parsed.lockfileVersion).toBeGreaterThanOrEqual(2);
  });

  test("every locked dependency is pinned exactly", () => {
    const manifest = JSON.parse(readToolchainLock().manifest) as {
      dependencies: Record<string, string>;
    };
    for (const version of Object.values(manifest.dependencies)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

describe("toolchainFingerprint", () => {
  // The manifest names direct versions; the lockfile names the whole resolved
  // tree. Hashing the lock is what makes a purely transitive change mint a new
  // tag instead of quietly reusing one.
  test("changes when the lockfile changes, even at identical direct versions", () => {
    const specs = ["@alexkroman1/aai@5.7.0"];
    const a = toolchainFingerprint(specs, { manifest: "{}", lock: '{"a":1}' });
    const b = toolchainFingerprint(specs, { manifest: "{}", lock: '{"a":2}' });
    expect(a).not.toEqual(b);
    expect(harnessImageTag("node:24-slim", "code", a)).not.toBe(
      harnessImageTag("node:24-slim", "code", b),
    );
  });

  test("ignores the manifest, which the lockfile already covers", () => {
    const specs = ["@alexkroman1/aai@5.7.0"];
    expect(toolchainFingerprint(specs, { manifest: "{}", lock: "L" })).toEqual(
      toolchainFingerprint(specs, { manifest: '{"different":true}', lock: "L" }),
    );
  });
});

describe("toolchainImage", () => {
  function fakeImage(): Image & { commands: string[][] } {
    const commands: string[][] = [];
    const image = {
      commands,
      dockerfileCommands(next: string[]) {
        commands.push(next);
        return image;
      },
    } as unknown as Image & { commands: string[][] };
    return image;
  }

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
      expect(payload).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(payload.length).toBeGreaterThan(0);
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
  function make(opts: { publishedTags?: Set<string>; failSnapshot?: boolean } = {}) {
    const publishedTags = opts.publishedTags ?? new Set<string>();
    const state = {
      published: [] as string[],
      writes: [] as { data: string; path: string }[],
      created: 0,
      terminated: 0,
      fromNameCalls: [] as string[],
      builds: 0,
    };
    const snapshot = {
      publish: (tag: string) => {
        state.published.push(tag);
        publishedTags.add(tag);
        return Promise.resolve();
      },
    } as unknown as Image;
    const baseImage = {
      dockerfileCommands: () => baseImage,
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
            snapshotFilesystem: () =>
              opts.failSnapshot
                ? Promise.reject(new Error("snapshot failed"))
                : Promise.resolve(snapshot),
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

  test("computes the tag once per distinct code, not once per spawn", async () => {
    const { resolve } = make();
    await resolve("harness code");
    const spy = vi.spyOn(JSON, "parse");
    await resolve("harness code");
    // Cached by code: the second call re-reads no package.json, so a spawn
    // never pays SHA-256 over the ~13 MB bundle plus a handful of reads.
    expect(spy.mock.calls).toHaveLength(0);
    spy.mockRestore();
  });
});
