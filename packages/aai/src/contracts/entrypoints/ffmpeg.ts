// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `ffmpeg`.
 *
 * Running ffmpeg from a step: the bounded runner, the two conveniences over it,
 * and the failure they throw.
 *
 * The binary-path env vars and the spawn budgets are on
 * `@alexkroman1/aai/host-internal`, which is not contracted: their reader is
 * the operator who installed ffmpeg, not the step that runs it.
 *
 * `ffmpegVersion` was on that subpath too and is NOT any more — the seam-shrink
 * that removed it (#1433) dropped every name with no importer, and it had none.
 * It still exists in `host/_ffmpeg-version.ts` with its own tests and is now
 * reachable from no export at all; restoring it means giving it a caller, not
 * re-adding the line.
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
} from "../../host/ffmpeg-barrel.ts";
