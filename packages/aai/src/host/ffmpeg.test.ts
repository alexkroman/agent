// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the ffmpeg runner, driven against a FAKE child process.
 *
 * The four properties `ffmpeg.ts` exists for — bounded output, an abortable
 * deadline, a failure that says which kind it is, and a missing binary that
 * names its remedy — are all properties of how the child is handled, not of
 * ffmpeg. So they are asserted here, in memory, where a test can emit 12 bytes
 * against an 8-byte cap or an ENOENT on demand. What needs a real binary is
 * whether the ARGV is right, and that is `ffmpeg.scenario.test.ts`.
 */

import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_MAX_FFMPEG_OUTPUT_BYTES,
  FFMPEG_STDERR_TAIL_CHARS,
  type FfmpegError,
  isFfmpegError,
} from "./_ffmpeg-spawn.ts";
import { ffmpegVersion } from "./_ffmpeg-version.ts";
import { tick } from "./_test-utils.ts";
import { ffmpegBaseArgs, probeMedia, runFfmpeg, transcodeToWav, wavEncodeArgs } from "./ffmpeg.ts";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

/**
 * A child process the test drives.
 *
 * Only what `spawnFfmpeg` touches: two output emitters, a writable stdin, the
 * `error`/`close` events, and `kill`. Nothing is annotated as a
 * `ChildProcess` — the mocked module's value is untyped, so the fake needs no
 * cast to stand in for one, which is what keeps this file's escape-hatch count
 * at zero.
 */
function installChild() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const dataListeners = new Map<string, (chunk: Buffer) => void>();
  let stdinErrorListener: ((err: Error) => void) | undefined;
  const state = {
    calls: [] as { binary: string; args: string[]; options: Record<string, unknown> }[],
    kills: [] as (string | undefined)[],
    stdinChunks: [] as Uint8Array[],
    stdinEnded: false,
  };
  const stream = (name: string) => ({
    on(event: string, cb: (chunk: Buffer) => void) {
      if (event === "data") dataListeners.set(name, cb);
      return this;
    },
  });
  const child = {
    stdout: stream("stdout"),
    stderr: stream("stderr"),
    stdin: {
      on(_event: string, cb: (err: Error) => void) {
        stdinErrorListener = cb;
        return this;
      },
      end(bytes?: Uint8Array) {
        state.stdinEnded = true;
        if (bytes) state.stdinChunks.push(bytes);
      },
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      listeners.set(event, cb);
      return child;
    },
    kill(signal?: string) {
      state.kills.push(signal);
    },
  };
  spawnMock.mockImplementation(
    (binary: string, args: string[], options: Record<string, unknown>) => {
      state.calls.push({ binary, args, options });
      return child;
    },
  );
  // GETTERS, not a spread of `state`: spreading copies the booleans at return
  // time, so `stdinEnded` would answer what it was before the run started.
  return {
    get call() {
      return state.calls[0];
    },
    get kills() {
      return state.kills;
    },
    get stdinChunks() {
      return state.stdinChunks;
    },
    get stdinEnded() {
      return state.stdinEnded;
    },
    stdout: (data: string | Uint8Array) => dataListeners.get("stdout")?.(Buffer.from(data)),
    stderrText: (text: string) => dataListeners.get("stderr")?.(Buffer.from(text)),
    stdinError: (err: Error) => stdinErrorListener?.(err),
    close: (code: number | null, signal: string | null = null) =>
      listeners.get("close")?.(code, signal),
    error: (err: Error) => listeners.get("error")?.(err),
  };
}

const enoent = (): NodeJS.ErrnoException =>
  Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });

const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });

/**
 * The {@link FfmpegError} a run failed with, or a test failure naming what came
 * back instead.
 *
 * A typed seam rather than an `as FfmpegError` per case: `promise.catch(e => e)`
 * widens to `Result | unknown`, so every assertion below would otherwise
 * re-narrow by hand — and a run that unexpectedly SUCCEEDED would read as an
 * error object with every field undefined.
 */
async function failureOf(run: Promise<unknown>): Promise<FfmpegError> {
  const outcome: unknown = await run.then(
    (value) => value,
    (err: unknown) => err,
  );
  if (!isFfmpegError(outcome)) {
    // A throw rather than `expect.fail`: Biome's `noMisplacedAssertion` — and it
    // is right — reserves assertions for a test body. This reads the same way in
    // the report, and it narrows, which is the helper's whole purpose.
    throw new Error(`expected an FfmpegError, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe("runFfmpeg", () => {
  test("spawns the argv verbatim, adding no flags of its own", async () => {
    const child = installChild();
    const run = runFfmpeg(["-i", "in.wav", "out.wav"]);
    child.close(0);
    await run;

    // The argv in a failure is meant to be pasteable into a shell, which only
    // holds while nothing is injected behind the caller's back.
    expect(child.call?.binary).toBe("ffmpeg");
    expect(child.call?.args).toEqual(["-i", "in.wav", "out.wav"]);
  });

  test("answers with stdout bytes, the stderr tail, and how long it took", async () => {
    const child = installChild();
    const run = runFfmpeg(["-version"]);
    child.stdout("RIFF");
    child.stderrText("frame= 100 fps=25\n");
    child.close(0);
    const result = await run;

    expect(Buffer.from(result.stdout).toString()).toBe("RIFF");
    // stderr comes back on SUCCESS too: it carries ffmpeg's encode summary.
    expect(result.stderr).toBe("frame= 100 fps=25\n");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("ignores stdin when there are no bytes to write", async () => {
    const child = installChild();
    const run = runFfmpeg(["-version"]);
    child.close(0);
    await run;
    // An open pipe nobody writes lets a child that reads stdin block until the
    // deadline instead of seeing EOF.
    expect(child.call?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  test("pipes stdin bytes and ends the stream", async () => {
    const child = installChild();
    const run = runFfmpeg(["-i", "pipe:0", "out.wav"], { stdin: new Uint8Array([1, 2, 3]) });
    child.close(0);
    await run;

    expect(child.call?.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(child.stdinChunks).toEqual([new Uint8Array([1, 2, 3])]);
    expect(child.stdinEnded).toBe(true);
  });

  /**
   * ffmpeg exits as soon as it has what it needs (`-t 5` of a long input, a bad
   * header), and the write in flight then fails with EPIPE. An unhandled
   * `error` on that stream takes the whole process down, so the outcome has to
   * come from the child's own exit.
   */
  test("survives an EPIPE on stdin — the child's exit is the outcome", async () => {
    const child = installChild();
    const run = runFfmpeg(["-i", "pipe:0", "out.wav"], { stdin: new Uint8Array([1]) });
    child.stdinError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    child.close(0);
    await expect(run).resolves.toMatchObject({ stderr: "" });
  });

  test("rejects a non-zero exit as kind `exit`, carrying the code and the log", async () => {
    const child = installChild();
    const run = runFfmpeg(["-i", "broken.m4a", "out.wav"]);
    child.stderrText("Invalid data found when processing input\n");
    child.close(1);

    const err = await failureOf(run);
    expect(err).toMatchObject({
      kind: "exit",
      exitCode: 1,
      binary: "ffmpeg",
      argv: ["-i", "broken.m4a", "out.wav"],
    });
    expect(err.stderr).toContain("Invalid data found");
    // The reason is in the message too: a caller that only logs `err.message`
    // must not have to know about `.stderr` to see the diagnosis.
    expect(err.message).toContain("Invalid data found");
  });

  test("keeps the END of a long log, marking the elision", async () => {
    const child = installChild();
    const run = runFfmpeg(["-i", "in.wav", "out.wav"]);
    child.stderrText("A".repeat(FFMPEG_STDERR_TAIL_CHARS));
    child.stderrText("B".repeat(64));
    child.close(1);

    const err = await failureOf(run);
    // ffmpeg's progress lines push the diagnosis to the end, so the tail is the
    // informative half — a head would be the banner every time.
    expect(err.stderr).toHaveLength(FFMPEG_STDERR_TAIL_CHARS + 1);
    expect(err.stderr.startsWith("…")).toBe(true);
    expect(err.stderr.endsWith("B".repeat(64))).toBe(true);
  });

  test("reports a missing binary by name, with the way to fix it", async () => {
    const child = installChild();
    const run = runFfmpeg(["-version"]);
    child.error(enoent());

    const err = await failureOf(run);
    expect(err.kind).toBe("missing-binary");
    // ENOENT here is `aai dev` on a laptop, so the message is an instruction
    // rather than `spawn ffmpeg ENOENT`.
    expect(err.message).toContain("apt-get install ffmpeg");
    expect(err.message).toContain("AAI_FFMPEG_PATH");
  });

  test("reports a caller's abort as `aborted`, not as a timeout", async () => {
    const child = installChild();
    const controller = new AbortController();
    const run = runFfmpeg(["-i", "in.wav", "out.wav"], { signal: controller.signal });
    controller.abort();
    child.error(abortError());

    const err = await failureOf(run);
    expect(err.kind).toBe("aborted");
  });

  /**
   * The deadline's own signal is the discriminator, which is what makes a
   * caller's abort in the last second of a long budget still read as an abort.
   * `timeoutMs: 0` fires it on the next macrotask; the fake child then closes
   * the way a real one killed by the signal does.
   */
  test("reports its own deadline as `timeout`", async () => {
    const child = installChild();
    const run = runFfmpeg(["-i", "in.wav", "out.wav"], { timeoutMs: 0 });
    await tick();
    child.close(null, "SIGTERM");

    const err = await failureOf(run);
    expect(err.kind).toBe("timeout");
    expect(err.message).toContain("0ms");
  });

  /**
   * The window between a child exiting 0 and `close` firing is real, and a
   * caller aborting inside it used to lose finished work: the abort check ran
   * first and reported `aborted` for a run that had already succeeded.
   */
  test("keeps a zero exit even when the caller aborts before close", async () => {
    const child = installChild();
    const controller = new AbortController();
    const run = runFfmpeg(["-i", "in.wav", "out.wav"], { signal: controller.signal });
    child.stdout("done");
    controller.abort();
    child.close(0);

    await expect(run).resolves.toMatchObject({ stderr: "" });
  });

  test("kills the child when piped output passes the cap", async () => {
    const child = installChild();
    const run = runFfmpeg(["-i", "in.wav", "pipe:1"], { maxOutputBytes: 8 });
    child.stdout(Buffer.alloc(12));
    child.close(null, "SIGKILL");

    const err = await failureOf(run);
    // Killed rather than kept reading: the guest's heap is what runs out, and
    // it runs out WHILE we buffer.
    expect(child.kills).toEqual(["SIGKILL"]);
    expect(err.kind).toBe("output-too-large");
    expect(err.message).toContain("maxOutputBytes");
  });

  test("caps piped output at 64 MiB unless told otherwise", () => {
    // An hour of 16 kHz mono PCM is ~115 MB, so the default is deliberately
    // BELOW a long recording: the remedy is a file, not a bigger heap.
    expect(DEFAULT_MAX_FFMPEG_OUTPUT_BYTES).toBe(64 * 1024 * 1024);
  });

  test("passes cwd through, so a relative path in the argv resolves", async () => {
    const child = installChild();
    const run = runFfmpeg(["-i", "in.wav", "out.wav"], { cwd: "/tmp/work" });
    child.close(0);
    await run;
    expect(child.call?.options.cwd).toBe("/tmp/work");
  });
});

describe("binary resolution", () => {
  test("prefers the explicit override, then AAI_FFMPEG_PATH, then FFMPEG_PATH", async () => {
    vi.stubEnv("AAI_FFMPEG_PATH", "/opt/aai-ffmpeg");
    vi.stubEnv("FFMPEG_PATH", "/usr/local/bin/ffmpeg");

    const first = installChild();
    const explicit = runFfmpeg(["-version"], { binary: "/custom/ffmpeg" });
    first.close(0);
    await explicit;
    expect(first.call?.binary).toBe("/custom/ffmpeg");

    const second = installChild();
    const fromAai = runFfmpeg(["-version"]);
    second.close(0);
    await fromAai;
    // The AAI-prefixed name wins, so an operator can pin one binary for this
    // SDK without disturbing whatever else on the box reads the other.
    expect(second.call?.binary).toBe("/opt/aai-ffmpeg");

    vi.stubEnv("AAI_FFMPEG_PATH", "");
    const third = installChild();
    const fromConventional = runFfmpeg(["-version"]);
    third.close(0);
    await fromConventional;
    expect(third.call?.binary).toBe("/usr/local/bin/ffmpeg");
  });

  test("falls back to the bare name on PATH", async () => {
    vi.stubEnv("AAI_FFMPEG_PATH", undefined);
    vi.stubEnv("FFMPEG_PATH", undefined);
    const child = installChild();
    const run = runFfmpeg(["-version"]);
    child.close(0);
    await run;
    expect(child.call?.binary).toBe("ffmpeg");
  });
});

describe("probeMedia", () => {
  const PROBE_JSON = JSON.stringify({
    streams: [{ index: 0, codec_type: "audio", codec_name: "aac", sample_rate: "44100" }],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.5" },
  });

  test("asks ffprobe for JSON about a path, and reads the answer", async () => {
    const child = installChild();
    const probe = probeMedia("/tmp/in.m4a");
    child.stdout(PROBE_JSON);
    child.close(0);
    const info = await probe;

    expect(child.call?.binary).toBe("ffprobe");
    expect(child.call?.args).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "/tmp/in.m4a",
    ]);
    expect(info.durationSec).toBe(12.5);
    expect(info.audio?.codec).toBe("aac");
  });

  test("reads bytes over pipe:0 instead of a path", async () => {
    const child = installChild();
    const probe = probeMedia(new Uint8Array([82, 73, 70, 70]));
    child.stdout(PROBE_JSON);
    child.close(0);
    await probe;

    expect(child.call?.args.at(-1)).toBe("pipe:0");
    expect(child.stdinChunks).toEqual([new Uint8Array([82, 73, 70, 70])]);
  });

  test("names the ffprobe env var when ffprobe is the missing binary", async () => {
    vi.stubEnv("AAI_FFPROBE_PATH", undefined);
    vi.stubEnv("FFPROBE_PATH", undefined);
    const child = installChild();
    const probe = probeMedia("/tmp/in.m4a");
    child.error(enoent());

    const err = await failureOf(probe);
    expect(err.kind).toBe("missing-binary");
    expect(err.message).toContain("AAI_FFPROBE_PATH");
  });

  /**
   * The variable is named by the CALLER, not derived from the resolved path —
   * which only ever worked for the two bare defaults. An operator who set
   * `binary` to a path that does not exist needs the name of the variable that
   * would have found it, and `ffprobe` is the case where guessing goes wrong.
   */
  test("still names the ffprobe variable when the override path is missing", async () => {
    const child = installChild();
    const probe = probeMedia("/tmp/in.m4a", { binary: "/opt/custom/probe" });
    child.error(enoent());

    const err = await failureOf(probe);
    expect(err.binary).toBe("/opt/custom/probe");
    expect(err.message).toContain("AAI_FFPROBE_PATH");
    expect(err.message).not.toContain("AAI_FFMPEG_PATH");
  });
});

describe("wavEncodeArgs", () => {
  test("asks for linear PCM, dropping video", () => {
    expect(wavEncodeArgs()).toEqual(["-vn", "-c:a", "pcm_s16le", "-f", "wav"]);
  });

  test("omits the rate and channel flags rather than guessing a default", () => {
    // ffmpeg keeps the input's own rate when it is not told one; passing a
    // guess here would silently resample every file that omitted it.
    expect(wavEncodeArgs({ channels: 1 })).toEqual([
      "-vn",
      "-c:a",
      "pcm_s16le",
      "-ac",
      "1",
      "-f",
      "wav",
    ]);
    expect(wavEncodeArgs({ sampleRate: 16_000 })).toContain("-ar");
  });

  test("spells the sample width into the codec name", () => {
    expect(wavEncodeArgs({ bitsPerSample: 24 })).toContain("pcm_s24le");
    expect(wavEncodeArgs({ bitsPerSample: 32 })).toContain("pcm_s32le");
  });
});

describe("transcodeToWav", () => {
  test("pipes the input in and the WAV out, dropping video", async () => {
    const child = installChild();
    const transcode = transcodeToWav(new Uint8Array([0, 1]), { sampleRate: 16_000, channels: 1 });
    child.stdout("RIFF....WAVE");
    child.close(0);
    const wav = await transcode;

    expect(child.call?.args).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      // `-nostats` and `-y` arrived with `ffmpegBaseArgs`: this call used to be
      // the SDK's own copy of the prelude, and the one missing the flag that
      // keeps a failure diagnosable.
      "-nostats",
      "-nostdin",
      "-y",
      "-i",
      "pipe:0",
      "-vn",
      "-c:a",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      "pipe:1",
    ]);
    expect(Buffer.from(wav).toString()).toBe("RIFF....WAVE");
  });

  test("takes a path as readily as bytes", async () => {
    const child = installChild();
    const transcode = transcodeToWav("/tmp/in.m4a");
    child.stdout("RIFF");
    child.close(0);
    await transcode;
    expect(child.call?.args).toContain("/tmp/in.m4a");
    expect(child.stdinChunks).toEqual([]);
  });
});

describe("ffmpegVersion", () => {
  test("answers the first line of -version", async () => {
    const child = installChild();
    const version = ffmpegVersion();
    child.stdout("ffmpeg version 7.1.1\nbuilt with gcc\n");
    child.close(0);
    await expect(version).resolves.toBe("ffmpeg version 7.1.1");
  });

  test("answers undefined when there is no ffmpeg to ask", async () => {
    const child = installChild();
    const version = ffmpegVersion();
    child.error(enoent());
    await expect(version).resolves.toBeUndefined();
  });

  /**
   * A binary that is present and broken is a real failure. Swallowing it would
   * report the same thing as an absence, and a preflight check that cannot tell
   * those apart sends the caller to install software they already have.
   */
  test("rethrows a binary that runs and fails", async () => {
    const child = installChild();
    const version = ffmpegVersion();
    child.stderrText("Unrecognized option\n");
    child.close(1);
    await expect(version).rejects.toMatchObject({ kind: "exit" });
  });
});

describe("ffmpegBaseArgs", () => {
  test("carries the two flags the five hand-written copies disagreed on", () => {
    const argv = ffmpegBaseArgs();
    // `-nostats` keeps ffmpeg's per-second progress line from filling the
    // captured stderr tail and evicting the error that explains a failure.
    expect(argv).toContain("-nostats");
    // `-nostdin` is about the guest, where there is no terminal and an ffmpeg
    // that reads stdin never exits.
    expect(argv).toContain("-nostdin");
    expect(argv).toContain("-hide_banner");
    expect(argv).toContain("-y");
  });

  test("defaults to error and takes a louder level for a filter that logs", () => {
    // `loudnorm`'s `print_format=json` reports through the LOG, so a measure
    // pass at `error` runs, succeeds, and prints nothing.
    expect(ffmpegBaseArgs()).toEqual(expect.arrayContaining(["-loglevel", "error"]));
    const info = ffmpegBaseArgs({ loglevel: "info" });
    expect(info[info.indexOf("-loglevel") + 1]).toBe("info");
    expect(info).not.toContain("error");
  });

  test("a caller cannot mutate the next caller's flags", () => {
    // A shared frozen constant would make `[...base, "-i", x]` fine and
    // `base.push(...)` a cross-call bug; a fresh array per call has neither.
    ffmpegBaseArgs().push("-boom");
    expect(ffmpegBaseArgs()).not.toContain("-boom");
  });

  test("transcodeToWav goes through it, so the SDK's own call is not the outlier", async () => {
    const child = installChild();
    const done = transcodeToWav("/tmp/in.m4a");
    child.stdout("RIFF....WAVE");
    child.close(0);
    await done;
    const argv = child.call?.args ?? [];
    // The regression this closes: `transcodeToWav` shipped without `-nostats`,
    // so the SDK's own transcode was the case whose diagnosis got evicted.
    expect(argv).toEqual(expect.arrayContaining(ffmpegBaseArgs()));
  });
});
