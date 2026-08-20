// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `ffmpeg`.
 *
 * Running ffmpeg from a step: the bounded runner, the two conveniences over it,
 * and the failure they throw.
 *
 * Re-exported from `@alexkroman1/aai/ffmpeg`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  DEFAULT_FFMPEG_TIMEOUT_MS,
  DEFAULT_MAX_FFMPEG_OUTPUT_BYTES,
  FFMPEG_PATH_ENV,
  FFMPEG_STDERR_TAIL_CHARS,
  FFPROBE_PATH_ENV,
  FfmpegError,
  type FfmpegFailureKind,
  type FfmpegRunOptions,
  type FfmpegRunResult,
  ffmpegVersion,
  isFfmpegError,
  type MediaInfo,
  type MediaSource,
  type MediaStream,
  type ProbeOptions,
  probeMedia,
  runFfmpeg,
  type TranscodeToWavOptions,
  transcodeToWav,
  type WavEncodeOptions,
  wavEncodeArgs,
} from "../../host/ffmpeg.ts";
