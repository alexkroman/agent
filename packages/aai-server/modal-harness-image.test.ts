// Copyright 2026 the AAI authors. MIT license.

import type { App, Image, ModalClient } from "modal";
import { describe, expect, test, vi } from "vitest";
import {
  createHarnessImageResolver,
  GUEST_ROOT,
  HARNESS_REMOTE_PATH,
  harnessImageTag,
  resolveToolchainSpecs,
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

describe("resolveToolchainSpecs", () => {
  test("resolves an installable spec per toolchain package", () => {
    const specs = resolveToolchainSpecs();
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec).toMatch(/^(@[^@/]+\/)?[^@]+@\S+$/);
      // A `workspace:` protocol is not installable by npm in the guest — the
      // aai packages must arrive as the versions this checkout resolved.
      expect(spec).not.toContain("workspace:");
    }
  });

  test("pins the aai packages to the exact versions this server runs", () => {
    const aai = resolveToolchainSpecs().filter((spec) => spec.startsWith("@alexkroman1/"));
    expect(aai.length).toBeGreaterThan(0);
    for (const spec of aai) {
      // Exact, not a range: the baked SDK must be the build the harness was
      // tested against, or a deployed bundle meets a different one.
      expect(spec).toMatch(/@\d+\.\d+\.\d+$/);
    }
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

  test("installs the toolchain in ONE cached RUN layer under the guest root", () => {
    const image = fakeImage();
    toolchainImage(image, ["zod@4.4.3", "vite@8.1.5"]);
    expect(image.commands).toHaveLength(1);
    const [layer] = image.commands;
    // One RUN for the install, so Modal caches it as a single layer rather
    // than one per package.
    const installs = layer?.filter((line) => line.includes("npm install")) ?? [];
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain(`--prefix ${GUEST_ROOT}`);
    expect(installs[0]).toContain("zod@4.4.3 vite@8.1.5");
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

  const tagFor = (code: string): string =>
    harnessImageTag("node:24-slim", code, resolveToolchainSpecs());

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
