// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the fixture helpers in `_test-utils.ts`.
 *
 * Only the ones that can fail SILENTLY are here, which today is one:
 * `linkSdkNodeModules` used to swallow every EEXIST, so a fixture that already
 * held a `node_modules` kept it, the SDK was never linked, and the build failed
 * several layers away with `Could not resolve "@alexkroman1/aai/utils"`. A helper
 * whose whole job is to make an import resolve has to say when it did not.
 *
 * `_e2e-test-utils.test.ts` is the same idea one tier up.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { linkSdkNodeModules, withTempDir } from "./_test-utils.ts";

const SDK_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

describe("linkSdkNodeModules", () => {
  test("links this package's node_modules into the fixture", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
      const link = await fs.readlink(path.join(dir, "node_modules"));
      expect(path.resolve(dir, link)).toBe(SDK_NODE_MODULES);
    });
  });

  test("forgives a SECOND call, because a fixture may be linked twice", async () => {
    await withTempDir(async (dir) => {
      await linkSdkNodeModules(dir);
      await expect(linkSdkNodeModules(dir)).resolves.toBeUndefined();
    });
  });

  test("REFUSES a fixture that already carries its own node_modules", async () => {
    // The case that cost a diagnosis. A stray `node_modules/.vite` left in a
    // template by an earlier vite run travelled into the copy the workflow-build
    // test makes, won the EEXIST, and the SDK silently never got linked — so the
    // failure named an unresolvable import and nothing named the symlink.
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, "node_modules", ".vite"), { recursive: true });
      await expect(linkSdkNodeModules(dir)).rejects.toThrow(/already exists and is not a link/);
    });
  });

  test("REFUSES a link pointing somewhere else", async () => {
    // `readlink` rather than `stat` is what makes this reachable: a `stat` follows
    // the link and would report a directory that exists, which is true and not the
    // question being asked.
    await withTempDir(async (dir) => {
      await fs.symlink(
        path.resolve(import.meta.dirname, ".."),
        path.join(dir, "node_modules"),
        "dir",
      );
      await expect(linkSdkNodeModules(dir)).rejects.toThrow(/will not\s+resolve there/);
    });
  });
});
