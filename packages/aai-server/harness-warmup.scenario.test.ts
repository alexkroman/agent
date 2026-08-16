// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest harness HONOURS the warm-up the snapshot image build asks for.
 *
 * `modal-harness-image.test.ts` proves the host half — the build execs the
 * harness with `AAI_GUEST_WARMUP=1` and `NODE_COMPILE_CACHE`, before taking the
 * filesystem snapshot. This is the half a fake cannot check, and the half that
 * silently rots: warm-up mode has to be reached BEFORE the `AAI_GUEST_TOKEN`
 * requirement (it is handed no token), so moving that check earlier would leave
 * the image snapshotting an empty cache with every host-side test still green.
 *
 * SCENARIO tier: it spawns a real subprocess and writes a real temp directory,
 * which is the membership rule (AGENTS.md, "Test tiers"). It sat in the unit
 * tier with a hand-written `timeout: 90_000` — the compensating scaffolding
 * AGENTS.md predicts when a timeout stands in for a tier. It covers no
 * aai-server source of its own (it runs the BUILT harness in a child process),
 * so the move costs the package no measured coverage.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { resolveHarnessPath } from "./constants.ts";

describe("harness warm-up mode (real spawn)", () => {
  const run = promisify(execFile);

  test("exits 0 with no token and populates the compile cache", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "harness-warmup-"));
    try {
      const { stderr } = await run(process.execPath, [resolveHarnessPath()], {
        env: {
          PATH: process.env.PATH ?? "",
          AAI_GUEST_WARMUP: "1",
          NODE_COMPILE_CACHE: cacheDir,
        },
        timeout: 60_000,
      });
      // A zero exit is execFile resolving rather than rejecting. The message
      // is what an image build greps for when the cache comes out empty.
      expect(stderr).toContain("harness warm-up complete");
      // The point of the whole exercise: bytecode on disk for the snapshot.
      expect(await readdir(cacheDir)).not.toHaveLength(0);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
