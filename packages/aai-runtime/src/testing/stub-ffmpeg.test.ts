// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the scripted ffmpeg child, driven through the SDK's REAL runners.
 *
 * What is asserted is the contract a step spec relies on: the script sees the
 * argv the runner built, its reply comes back as the runner's own result, and
 * a failure it stages is classified by the SDK exactly as a real child's would
 * be — so a step's `throwFfmpegStepError` branch is reachable from a unit test.
 */

import { type FfmpegError, isFfmpegError, probeMedia, runFfmpeg } from "@alexkroman1/aai/ffmpeg";
import { describe, expect, test } from "vitest";
import { installStubFfmpeg } from "./stub-ffmpeg.ts";

/** The failure a run rejected with, or a test failure naming what came back. */
async function failureOf(run: Promise<unknown>): Promise<FfmpegError> {
  const outcome: unknown = await run.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!isFfmpegError(outcome)) throw new Error(`expected an FfmpegError, got ${String(outcome)}`);
  return outcome;
}

describe("installStubFfmpeg", () => {
  test("the script sees the argv, and its reply is the run's result", async () => {
    const ffmpeg = installStubFfmpeg(({ args }) => ({
      stdout: `saw ${args.length} args`,
      stderr: "frame=1",
    }));

    const run = await runFfmpeg(["-i", "in.wav", "out.wav"], { binary: "fake-ffmpeg" });

    expect(Buffer.from(run.stdout).toString()).toBe("saw 3 args");
    expect(run.stderr).toBe("frame=1");
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(ffmpeg.calls).toEqual([
      { binary: "fake-ffmpeg", args: ["-i", "in.wav", "out.wav"], stdin: undefined },
    ]);
  });

  test("no script at all is a child that prints nothing and exits 0", async () => {
    installStubFfmpeg();
    await expect(runFfmpeg(["-i", "x"], { binary: "fake-ffmpeg" })).resolves.toMatchObject({
      stderr: "",
    });
  });

  test("a non-zero exit is the SDK's own `exit` failure, stderr attached", async () => {
    installStubFfmpeg(() => ({ exitCode: 1, stderr: "in.wav: No such file" }));
    const failure = await failureOf(runFfmpeg(["-i", "in.wav"], { binary: "fake-ffmpeg" }));
    expect(failure.kind).toBe("exit");
    expect(failure.message).toMatch(/exited with code 1/);
    expect(failure.message).toMatch(/No such file/);
  });

  test("a spawnError is classified as the SDK classifies a real one", async () => {
    installStubFfmpeg(() => ({
      spawnError: Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }),
    }));
    const failure = await failureOf(runFfmpeg(["-i", "x"], { binary: "fake-ffmpeg" }));
    expect(failure.kind).toBe("missing-binary");
  });

  test("stdin bytes reach the script, for an argv that reads pipe:0", async () => {
    const ffmpeg = installStubFfmpeg();
    const bytes = new Uint8Array([1, 2, 3]);
    await runFfmpeg(["-i", "pipe:0", "-f", "null", "-"], { binary: "fake-ffmpeg", stdin: bytes });
    expect(ffmpeg.calls[0]?.stdin).toEqual(bytes);
  });

  test("a script that throws fails the run with its message rather than hanging it", async () => {
    installStubFfmpeg(() => {
      throw new Error("the fixture is missing");
    });
    await expect(runFfmpeg(["-i", "x"], { binary: "fake-ffmpeg" })).rejects.toThrow(
      /the fixture is missing/,
    );
  });

  test("probeMedia reads the scripted stdout as ffprobe's JSON", async () => {
    installStubFfmpeg(({ args }) =>
      args.includes("-show_streams")
        ? { stdout: JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "aac" }] }) }
        : undefined,
    );
    const info = await probeMedia("/tmp/anything.m4a", { binary: "fake-ffprobe" });
    expect(info.audio?.codec).toBe("aac");
  });

  test("the script may be async and may run per call", async () => {
    let served = 0;
    const ffmpeg = installStubFfmpeg(async () => {
      await Promise.resolve();
      served += 1;
      return { stderr: `call ${served}` };
    });
    const first = await runFfmpeg(["-i", "a"], { binary: "fake-ffmpeg" });
    const second = await runFfmpeg(["-i", "b"], { binary: "fake-ffmpeg" });
    expect([first.stderr, second.stderr]).toEqual(["call 1", "call 2"]);
    expect(ffmpeg.calls.map((call) => call.args)).toEqual([
      ["-i", "a"],
      ["-i", "b"],
    ]);
  });
});
