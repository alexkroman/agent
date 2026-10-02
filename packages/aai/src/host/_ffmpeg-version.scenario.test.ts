// Copyright 2026 the AAI authors. MIT license.
/**
 * `ffmpegVersion` against a real child process.
 *
 * The installed case needs a real ffmpeg, so it is skipped without one — unless
 * `AAI_REQUIRE_FFMPEG` is set (CI's Linux leg), which runs it regardless so a
 * broken install fails rather than skipping, as `ffmpeg.scenario.test.ts` does.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { ffmpegVersion } from "./_ffmpeg-version.ts";

const HAVE_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const RUN_INSTALLED = HAVE_FFMPEG || (process.env.AAI_REQUIRE_FFMPEG ?? "") !== "";

describe("ffmpegVersion", () => {
  // Referenced rather than suppressed, as `ffmpeg.scenario.test.ts` does it:
  // Biome's `noSkippedTests` flags the `describe.skip(…)` call form.
  const skipSuite = describe.skip;
  (RUN_INSTALLED ? describe : skipSuite)("with ffmpeg installed", () => {
    test("ffmpegVersion answers what is installed", async () => {
      await expect(ffmpegVersion()).resolves.toMatch(/^ffmpeg version /);
    });
  });

  test("ffmpegVersion answers undefined for a binary that is not there", async () => {
    await expect(ffmpegVersion({ binary: "aai-no-such-ffmpeg" })).resolves.toBeUndefined();
  });

  test("throws for a binary that is present but fails, rather than reporting it absent", async () => {
    // Node rejects `-hide_banner` and exits non-zero: a broken ffmpeg, not a missing one.
    await expect(ffmpegVersion({ binary: process.execPath })).rejects.toMatchObject({
      kind: "exit",
    });
  });
});
