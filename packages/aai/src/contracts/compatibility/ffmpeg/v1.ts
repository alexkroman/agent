// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:ffmpeg` epoch 1.
 *
 * A media step as it was authored at epoch 1: probe the recording, decide
 * whether it needs converting, and convert it — with the standing flags written
 * out by hand, because that is the only way epoch 1 offered. It must keep
 * compiling for as long as epoch 1 is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * Epoch 2 ADDED `ffmpegBaseArgs`. Additive: a new name breaks no caller, and no
 * existing signature moved.
 *
 * What DID change under an unchanged call is behaviour, and it is worth being
 * precise about because a retained epoch is a promise about behaviour too:
 * `transcodeToWav` now sends `-nostats` and `-y`, which it did not at epoch 1.
 * Both are quieting flags — `-nostats` stops ffmpeg's per-second progress line
 * from filling the captured stderr tail, `-y` overwrites an output it is
 * already writing to a pipe. The bytes it answers with are identical, and the
 * only observable difference is that a FAILING call now reports the error that
 * explains it instead of the progress spam that evicted it. A caller that could
 * not accept that is one asserting on ffmpeg's stderr text, which epoch 1 never
 * advertised as stable.
 *
 * {@link convertArgs} keeps the hand-written prelude, which is the epoch-1
 * spelling and has to keep working; nothing here names `ffmpegBaseArgs`.
 *
 * ## What this file freezes, and where a break would land
 *
 * Every one of the three OPTIONS types is constructed below and handed to the
 * call that takes it — {@link ENCODE}, {@link PROBE}, {@link RUN},
 * {@link IN_MEMORY}. That is the position a caller cannot absorb a change in:
 * an options object is written by the caller and read by the SDK, so a field
 * that disappears or stops being optional reddens at the literal, and one that
 * is merely ADDED does not. A capability whose whole surface is "a function and
 * the bag you pass it" is frozen by the bags, not by the calls.
 *
 * The two READ shapes are named on the other side of that boundary and break
 * the other way round: {@link isNormalized} takes a `MediaStreamInfo` and reads
 * two fields off it, and {@link explainFailure} takes an `FfmpegError` and
 * reads five, so a field going away from either is an error here where a new
 * field is not. `FfmpegFailureKind` is spelled out as a LIST rather than left
 * to a comparison ({@link RETRYABLE}) because it is a closed union a step
 * branches on exhaustively: a member removed from it is a step that stops
 * compiling, which is what a caller wants, and a member ADDED to it is a step
 * that silently stops retrying something it should — the one change in this
 * capability that no compiler can catch and the reason the list is written down
 * where a reviewer sees it.
 */

import {
  type FfmpegError,
  type FfmpegFailureKind,
  type FfmpegRunOptions,
  type FfmpegRunResult,
  type FfmpegSource,
  isFfmpegError,
  type MediaInfo,
  type MediaStreamInfo,
  type ProbeOptions,
  probeMedia,
  runFfmpeg,
  type TranscodeToWavOptions,
  transcodeToWav,
  type WavEncodeOptions,
  wavEncodeArgs,
} from "../../../host/ffmpeg.ts";

/** The target every downstream step in this example expects. */
const NORMALIZED = { sampleRate: 16_000, channels: 1 } as const;

/**
 * The encode half, as the options type rather than as an inline literal.
 *
 * `bitsPerSample` is passed even though 16 is the default, because it is the
 * number every byte offset downstream is arithmetic on: a fan-out that plans
 * cuts from a sample count is planning against this value, and a default that
 * moved would move the cuts without moving a line of the caller.
 */
const ENCODE: WavEncodeOptions = { ...NORMALIZED, bitsPerSample: 16 };

/**
 * What the probe is allowed to cost.
 *
 * Shorter than the run's budget on purpose — ffprobe reads a header, so a probe
 * that is still going after half a minute is a file the decoder cannot make
 * sense of rather than a slow one, and finding that out cheaply is the whole
 * reason to probe before converting.
 */
const PROBE: ProbeOptions = { timeoutMs: 30_000 };

/**
 * What the file-to-file run is allowed to cost, and how much of stdout to keep.
 *
 * The cap is small BECAUSE the output is a file: an argv ending in a path writes
 * nothing to the pipe, so anything arriving there is ffmpeg reporting rather
 * than audio, and a caller that leaves the default cap in place on a file-to-file
 * run has budgeted 64 MiB for a message.
 */
const RUN: FfmpegRunOptions = { timeoutMs: 10 * 60_000, maxOutputBytes: 64 * 1024 };

/**
 * The in-memory conversion's options: the encode, plus the budget for holding
 * the whole result.
 *
 * `maxOutputBytes` is the field that makes this shape different from the one
 * above rather than a copy of it — piped WAV is the output, so the cap is a
 * statement about how long a recording this step will accept, and exceeding it
 * kills the child instead of the container.
 */
const IN_MEMORY: TranscodeToWavOptions = {
  ...ENCODE,
  timeoutMs: 10 * 60_000,
  maxOutputBytes: 64 * 1024 * 1024,
};

/**
 * The two failure kinds asking again can change.
 *
 * Written as a list of the union rather than as two comparisons so the
 * vocabulary is visible at one place: an `exit` on a corrupt file fails
 * identically on every attempt, and a step that retried it would spend its whole
 * attempt budget learning that.
 */
const RETRYABLE: readonly FfmpegFailureKind[] = ["timeout", "aborted"];

/** Whether one probed stream already is what the fan-out can cut. */
export function isNormalized(audio: MediaStreamInfo): boolean {
  return audio.sampleRate === NORMALIZED.sampleRate && audio.channels === NORMALIZED.channels;
}

/**
 * Whether a probed recording needs converting.
 *
 * A file with no audio stream at all answers `true` rather than throwing: the
 * conversion is what will report it, with ffmpeg's own message, and that is a
 * better sentence than anything this function could invent.
 */
export function needsConverting(info: MediaInfo): boolean {
  const audio = info.streams.find((stream) => stream.kind === "audio");
  return audio === undefined || !isNormalized(audio);
}

/**
 * The argv, with the standing flags spelled out — the epoch-1 way.
 *
 * `wavEncodeArgs` owned the encode half even at epoch 1; what it did not own is
 * the prelude, which is the gap epoch 2 closed.
 */
export function convertArgs(input: string, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    input,
    ...wavEncodeArgs(ENCODE),
    output,
  ];
}

/** Probe, decide, convert — file to file, so nothing is buffered. */
export async function normalize(input: string, output: string): Promise<boolean> {
  const info = await probeMedia(input, PROBE);
  if (!needsConverting(info)) return false;
  const result: FfmpegRunResult = await runFfmpeg(convertArgs(input, output), RUN);
  return result.stdout.byteLength >= 0;
}

/** The in-memory shape, for a recording small enough to hold. */
export async function normalizeBytes(source: FfmpegSource): Promise<Uint8Array> {
  return await transcodeToWav(source, IN_MEMORY);
}

/** The failure classification a step made at epoch 1. */
export function isRetryable(err: unknown): boolean {
  return isFfmpegError(err) && RETRYABLE.includes(err.kind);
}

/**
 * The failure as a line somebody can act on.
 *
 * `argv` and `binary` together are the command to paste into a shell, which is
 * the only reproduction anyone gets for a file that is already gone; `stderr` is
 * the tail ffmpeg wrote, which is where the reason is. `exitCode` is `null` for
 * a child that was killed, so it is reported rather than assumed — a step that
 * printed a number there would print `0` for the timeout case and read as a
 * success that failed.
 */
export function explainFailure(err: FfmpegError): string {
  const status =
    err.exitCode === null ? `killed (${err.signal ?? "no signal"})` : `exit ${err.exitCode}`;
  return `${err.kind}: ${status}\n${err.binary} ${err.argv.join(" ")}\n${err.stderr}`;
}
