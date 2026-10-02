// Copyright 2026 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveHarnessPath } from "../constants.ts";
import {
  harnessImageTag,
  readToolchainLock,
  resolveSdkSpecs,
  toolchainFingerprint,
} from "./harness-image.ts";

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
