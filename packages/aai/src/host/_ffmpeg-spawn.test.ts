// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { FFMPEG_PATH_ENV, FfmpegError, isFfmpegError, resolveBinary } from "./_ffmpeg-spawn.ts";

describe("resolveBinary", () => {
  const resolve = (override?: string) =>
    resolveBinary(FFMPEG_PATH_ENV, "FFMPEG_PATH", "ffmpeg", override);

  test("falls back to the bare name on PATH", () => {
    vi.stubEnv(FFMPEG_PATH_ENV, undefined);
    vi.stubEnv("FFMPEG_PATH", undefined);
    expect(resolve()).toBe("ffmpeg");
  });

  test("honours the conventional variable a developer's machine already sets", () => {
    vi.stubEnv(FFMPEG_PATH_ENV, undefined);
    vi.stubEnv("FFMPEG_PATH", "/opt/ffmpeg");
    expect(resolve()).toBe("/opt/ffmpeg");
  });

  test("prefers the AAI_ variable over the conventional one", () => {
    vi.stubEnv(FFMPEG_PATH_ENV, "/aai/ffmpeg");
    vi.stubEnv("FFMPEG_PATH", "/opt/ffmpeg");
    expect(resolve()).toBe("/aai/ffmpeg");
  });

  test("prefers an explicit override over both", () => {
    vi.stubEnv(FFMPEG_PATH_ENV, "/aai/ffmpeg");
    expect(resolve("/explicit/ffmpeg")).toBe("/explicit/ffmpeg");
  });

  test("skips a blank value rather than spawning an empty path", () => {
    vi.stubEnv(FFMPEG_PATH_ENV, "   ");
    vi.stubEnv("FFMPEG_PATH", "/opt/ffmpeg");
    expect(resolve("")).toBe("/opt/ffmpeg");
  });

  test("trims what it reads", () => {
    vi.stubEnv(FFMPEG_PATH_ENV, " /aai/ffmpeg\n");
    expect(resolve()).toBe("/aai/ffmpeg");
  });
});

describe("FfmpegError", () => {
  test("defaults the fields a spawn failure has none of", () => {
    const err = new FfmpegError({
      kind: "missing-binary",
      message: "ffmpeg is not installed",
      binary: "ffmpeg",
      argv: ["-version"],
    });
    expect(err).toMatchObject({
      name: "FfmpegError",
      kind: "missing-binary",
      exitCode: null,
      signal: null,
      stderr: "",
      binary: "ffmpeg",
      argv: ["-version"],
    });
    expect("cause" in err).toBe(false);
  });

  test("keeps the cause it was given", () => {
    const cause = new Error("ENOENT");
    const err = new FfmpegError({ kind: "exit", message: "m", binary: "b", argv: [], cause });
    expect(err.cause).toBe(cause);
  });

  test("isFfmpegError narrows only the class itself, not a look-alike", () => {
    const err = new FfmpegError({ kind: "timeout", message: "m", binary: "b", argv: [] });
    expect(isFfmpegError(err)).toBe(true);
    expect(isFfmpegError({ name: "FfmpegError", kind: "timeout" })).toBe(false);
    expect(isFfmpegError(new Error("m"))).toBe(false);
  });
});
