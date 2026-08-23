// Copyright 2026 the AAI authors. MIT license.
/**
 * The ffmpeg helpers against a REAL ffmpeg.
 *
 * `ffmpeg.test.ts` covers everything about handling the child, driven by a fake
 * one. What a fake cannot cover is the half this file exists for: whether the
 * ARGV is right. `-print_format json` versus `-of json`, `-c:a pcm_s16le`
 * versus `-acodec`, whether `-f wav` to `pipe:1` produces something a decoder
 * accepts, whether a flag went in the wrong position — every one of those
 * passes a mocked spawn and fails on a user's first recording.
 *
 * No fixture bytes are committed. ffmpeg generates its own input (`lavfi`'s
 * `sine`), which keeps the suite honest about the thing under test — an argv —
 * rather than about a file someone recorded once.
 *
 * ## Skipping ANNOUNCES itself
 *
 * A skip is the worst outcome available for a suite that is the only thing
 * checking an argv, so this follows `describeWithPg` (aai-server): with no
 * ffmpeg it prints how to get one, and `AAI_REQUIRE_FFMPEG` — which CI's Linux
 * leg sets — turns the skip into a hard failure, so a broken install step
 * cannot read as a green run.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ffmpegVersion } from "./_ffmpeg-version.ts";
import {
  type FfmpegError,
  isFfmpegError,
  probeMedia,
  runFfmpeg,
  transcodeToWav,
  wavEncodeArgs,
} from "./ffmpeg.ts";

/** Both binaries, or neither — every case here needs `ffprobe` to check itself. */
const HAVE_FFMPEG = ["ffmpeg", "ffprobe"].every(
  (bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0,
);

const HOW_TO =
  "Install ffmpeg (`apt-get install ffmpeg`, `brew install ffmpeg`) or point\n" +
  "AAI_FFMPEG_PATH / AAI_FFPROBE_PATH at binaries. A deployed guest always has\n" +
  "them — GUEST_SYSTEM_PACKAGES in aai-server/modal-harness-image.ts.";

// Biome's `noSkippedTests` flags the `describe.skip(…)` call form, and a gated
// suite is what this file is; referenced rather than suppressed, exactly as
// `_pg-test-utils.ts` does it.
const skipSuite = describe.skip;

function describeWithFfmpeg(name: string, body: () => void): void {
  if (HAVE_FFMPEG) {
    describe(name, body);
    return;
  }
  if ((process.env.AAI_REQUIRE_FFMPEG ?? "") !== "") {
    throw new Error(`AAI_REQUIRE_FFMPEG is set but no ffmpeg was found.\n${HOW_TO}`);
  }
  console.warn(`\n[skipped: no ffmpeg] real-ffmpeg suite not run.\n${HOW_TO}\n`);
  skipSuite(name, body);
}

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

describeWithFfmpeg("ffmpeg helpers against a real binary", () => {
  let dir = "";
  /** One second of 440 Hz, 16 kHz mono PCM — the shape a transcription desk wants. */
  let wavPath = "";
  /** The same second, in a compressed container, to transcode FROM. */
  let flacPath = "";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aai-ffmpeg-"));
    wavPath = path.join(dir, "tone.wav");
    flacPath = path.join(dir, "tone.flac");
    const source = ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"];
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      ...source,
      ...wavEncodeArgs({ sampleRate: 16_000, channels: 1 }),
      wavPath,
    ]);
    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      ...source,
      "-ac",
      "1",
      "-ar",
      "16000",
      flacPath,
    ]);
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("wavEncodeArgs really produces linear PCM at the rate it asked for", async () => {
    const info = await probeMedia(wavPath);
    expect(info.format).toBe("wav");
    expect(info.audio).toMatchObject({ codec: "pcm_s16le", sampleRate: 16_000, channels: 1 });
    expect(info.durationSec).toBeCloseTo(1, 1);
  });

  test("probeMedia reads a compressed container the same way", async () => {
    const info = await probeMedia(flacPath);
    expect(info.audio?.codec).toBe("flac");
    // The distinction a pipeline branches on: not-PCM means transcode first.
    expect(info.audio?.codec).not.toBe("pcm_s16le");
  });

  test("probeMedia reads bytes over a pipe", async () => {
    const { stdout } = await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      flacPath,
      "-f",
      "flac",
      "pipe:1",
    ]);
    const info = await probeMedia(stdout);
    expect(info.audio?.codec).toBe("flac");
  });

  test("transcodeToWav turns compressed bytes into a WAV a decoder accepts", async () => {
    const { stdout: flac } = await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      flacPath,
      "-f",
      "flac",
      "pipe:1",
    ]);
    const wav = await transcodeToWav(flac, { sampleRate: 16_000, channels: 1 });

    // A RIFF header, and — the part that matters — ffprobe agreeing about what
    // is inside it. `parseWav` in the transcription template reads exactly
    // these first bytes.
    expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe("RIFF");
    expect(Buffer.from(wav.subarray(8, 12)).toString()).toBe("WAVE");

    const roundTripped = path.join(dir, "round-tripped.wav");
    await writeFile(roundTripped, wav);
    const info = await probeMedia(roundTripped);
    expect(info.audio).toMatchObject({ codec: "pcm_s16le", sampleRate: 16_000, channels: 1 });
    expect(info.durationSec).toBeCloseTo(1, 1);
  });

  test("reports a corrupt input as a plain exit, with ffmpeg's own reason", async () => {
    const err = await failureOf(probeMedia(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
    // `exit` and not `timeout`: a step must be able to tell "this file will
    // never work" from "this run needs another attempt".
    expect(err.kind).toBe("exit");
    expect(err.stderr.length).toBeGreaterThan(0);
  });

  test("kills a run that passes its deadline", async () => {
    // `-re` paces the synthetic input at real time, so this cannot finish
    // inside the budget however fast the machine is.
    const err = await failureOf(
      runFfmpeg(
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-re",
          "-f",
          "lavfi",
          "-i",
          "sine=duration=600",
          "-f",
          "wav",
          "pipe:1",
        ],
        { timeoutMs: 300 },
      ),
    );
    expect(err.kind).toBe("timeout");
  });

  test("kills a run whose piped output passes the cap", async () => {
    const err = await failureOf(
      runFfmpeg(
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=duration=30",
          "-f",
          "wav",
          "pipe:1",
        ],
        { maxOutputBytes: 1024 },
      ),
    );
    expect(err.kind).toBe("output-too-large");
  });

  test("ffmpegVersion answers what is installed", async () => {
    await expect(ffmpegVersion()).resolves.toMatch(/^ffmpeg version /);
  });

  test("ffmpegVersion answers undefined for a binary that is not there", async () => {
    await expect(ffmpegVersion({ binary: "aai-no-such-ffmpeg" })).resolves.toBeUndefined();
  });
});
