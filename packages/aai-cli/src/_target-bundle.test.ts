// Copyright 2026 the AAI authors. MIT license.
/**
 * The shared entry bundler, at the tier that needs no bundler.
 *
 * `bundleTargetEntry` runs a real rolldown pass over the whole runtime, so what
 * it produces is asserted in the scenario tier. What is here is the part every
 * caller depends on and no bundle is needed to check: that the temporary entry
 * it writes into the project does not SURVIVE, in either outcome.
 *
 * That matters because of where the file goes. It is written into the user's
 * own `.aai/` rather than a temp directory — the whole reason being that
 * `@alexkroman1/aai-cli/start` must resolve against their install — so a leak
 * leaves a file that looks authored, in a directory they will later deploy.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { bundleTargetEntry, targetPathExists } from "./_target-bundle.ts";
import { withTempDir } from "./_test-utils.ts";

describe("bundleTargetEntry", () => {
  test("removes its temporary entry when the bundle FAILS", async () => {
    await withTempDir(async (dir) => {
      // Nothing resolves `@alexkroman1/aai-cli/start` in a bare temp dir, so
      // this is the failure path — and the `finally` is the only thing that
      // cleans up on it.
      await expect(
        bundleTargetEntry(dir, 'import "@alexkroman1/aai-cli/start";\n', "probe"),
      ).rejects.toThrow();
      expect(await targetPathExists(path.join(dir, ".aai", "probe-entry.mjs"))).toBe(false);
    });
  });

  test("removes it on SUCCESS too, and answers the bundled code", async () => {
    await withTempDir(async (dir) => {
      // A source with nothing to resolve bundles fine in a bare directory,
      // which is what makes the success path reachable without an install.
      const code = await bundleTargetEntry(dir, "export default 1;\n", "vercel");
      // The bundler renames the default binding after the entry FILE, which is
      // the same fact the collision test below rests on.
      expect(code).toContain("vercel_entry_default");
      expect(await targetPathExists(path.join(dir, ".aai", "vercel-entry.mjs"))).toBe(false);
    });
  });

  test("the entry name is what keeps two targets from colliding", async () => {
    await withTempDir(async (dir) => {
      // Both targets bundle into the same `.aai/`, so the name is the only
      // thing separating a vercel emit from a deno one — and each carries its
      // own name into the chunk, so a shared filename would also mean one
      // target's bundle answering for the other's.
      const vercel = await bundleTargetEntry(dir, "export default 'V';\n", "vercel");
      const deno = await bundleTargetEntry(dir, "export default 'D';\n", "deno");
      expect(vercel).toContain('"V"');
      expect(deno).toContain('"D"');
      // The binding is named from the entry file, so a shared name would also
      // mean two targets' bundles were indistinguishable at a glance.
      expect(vercel).toContain("vercel_entry_default");
      expect(deno).toContain("deno_entry_default");
      for (const name of ["vercel", "deno"]) {
        expect(await targetPathExists(path.join(dir, ".aai", `${name}-entry.mjs`))).toBe(false);
      }
    });
  });
});

describe("targetPathExists", () => {
  test("answers for a file, a directory and an absence", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "a.txt"), "x");
      expect(await targetPathExists(path.join(dir, "a.txt"))).toBe(true);
      expect(await targetPathExists(dir)).toBe(true);
      // Never throws — every caller uses it to decide whether to copy an
      // OPTIONAL file, so an absence is an answer rather than a failure.
      expect(await targetPathExists(path.join(dir, "nope"))).toBe(false);
    });
  });
});
