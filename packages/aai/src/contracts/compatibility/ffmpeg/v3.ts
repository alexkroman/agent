// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:ffmpeg` epoch 3.
 *
 * A media step as it was authored at epoch 3: the standing flags come from
 * `ffmpegBaseArgs` rather than being spelled out by hand, which is the one thing
 * this epoch has that `v1.ts` deliberately does not. It must keep compiling for
 * as long as epoch 3 is advertised as supported.
 *
 * ## What moved, and why epoch 3 survives it
 *
 * Epoch 4 ADDED `describeMedia` — a probe as the `41:20 of aac` a progress line
 * wants, which both templates that probe had written for themselves. Additive: a
 * new name breaks no caller, and no existing signature moved. Nothing here names
 * it; {@link describe} is the hand-written phrase this epoch's callers carried,
 * and it has to keep compiling whether or not it is ever converted.
 *
 * ## What this file freezes
 *
 * `ffmpegBaseArgs` is the surface `v1.ts` leaves uncovered, so it is the one
 * name this file exists to name: the {@link convertArgs} argv is built from it
 * exactly as a caller would, and {@link measureArgs} reaches for the one option
 * it takes. The rest of the capability is frozen by `v1.ts`, and the coverage
 * rule is per capability, so nothing is repeated here for completeness' sake.
 */

import {
  ffmpegBaseArgs,
  type MediaInfo,
  probeMedia,
  runFfmpeg,
  wavEncodeArgs,
} from "../../../host/ffmpeg.ts";

/** The target every downstream step in this example expects. */
const NORMALIZED = { sampleRate: 16_000, channels: 1 } as const;

/**
 * The argv, with the standing flags from the SDK — the epoch-3 way.
 *
 * `-nostats` and `-nostdin` ride in with `ffmpegBaseArgs()`; at epoch 1 each
 * caller remembered them or did not, and the one that did not lost its error
 * under ffmpeg's progress spam.
 */
export function convertArgs(input: string, output: string): string[] {
  return [...ffmpegBaseArgs(), "-i", input, ...wavEncodeArgs(NORMALIZED), output];
}

/**
 * A pass that reports through the LOG, so the flags ask for `info`.
 *
 * `loudnorm`'s `print_format=json` writes its block to stderr at `info`, and at
 * the default `error` the pass runs, succeeds, and prints nothing — the one
 * option `ffmpegBaseArgs` takes exists for this call.
 */
export function measureArgs(input: string): string[] {
  return [
    ...ffmpegBaseArgs({ loglevel: "info" }),
    "-i",
    input,
    "-af",
    "loudnorm=print_format=json",
    "-f",
    "null",
    "-",
  ];
}

/** The phrase a progress line carried at epoch 3, before the SDK owned it. */
export function describe(info: MediaInfo): string {
  const codec = info.audio?.codec ?? "unknown";
  return info.durationSec === undefined ? codec : `${Math.round(info.durationSec)}s of ${codec}`;
}

/** Probe, describe, convert — file to file, so nothing is buffered. */
export async function normalize(input: string, output: string): Promise<string> {
  const info = await probeMedia(input, { timeoutMs: 30_000 });
  await runFfmpeg(convertArgs(input, output), { timeoutMs: 10 * 60_000 });
  return describe(info);
}
