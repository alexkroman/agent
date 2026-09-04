// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `ffmpeg`.
 *
 * Running ffmpeg from a step: the bounded runner, the two conveniences over it,
 * and the failure they throw.
 *
 * The binary-path env vars, the spawn budgets and `ffmpegVersion` are on
 * `@alexkroman1/aai/host-internal`, which is not contracted: their reader is
 * the operator who installed ffmpeg, not the step that runs it.
 *
 * Re-exported from `@alexkroman1/aai/ffmpeg`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  FfmpegError,
  type FfmpegFailureKind,
  type FfmpegRunOptions,
  type FfmpegRunResult,
  type FfmpegSource,
  ffmpegBaseArgs,
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
} from "../../host/ffmpeg.ts";
