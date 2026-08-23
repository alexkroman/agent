// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:ffmpeg` epoch 2.
 *
 * Epoch 2 is epoch 1 minus the six OPERATOR knobs — `FFMPEG_PATH_ENV`,
 * `FFPROBE_PATH_ENV`, `DEFAULT_FFMPEG_TIMEOUT_MS`,
 * `DEFAULT_MAX_FFMPEG_OUTPUT_BYTES`, `FFMPEG_STDERR_TAIL_CHARS` and
 * `ffmpegVersion` — which moved to `@alexkroman1/aai/host-internal`. Those two
 * env vars are deployment configuration (where the binaries are on this
 * machine) and the budgets are what the runner spends when a caller names
 * nothing; a `.d.ts` an agent author imports is the wrong place to publish
 * either.
 *
 * Two type names were RENAMED, and that is what makes this epoch `major` rather
 * than a subtraction nobody notices: `MediaStream` and `MediaSource` are DOM
 * globals, so a page that imported either from here shadowed the real one —
 * API Extractor was already renaming them `MediaStream_2`/`MediaSource_2` to
 * emit the report at all. They are {@link MediaStreamInfo} and
 * {@link FfmpegSource} now, which also puts the source type in the same
 * `Ffmpeg*` family as the error and the run options beside it.
 *
 * Epoch 1 is RETAINED — `./v1.ts` names none of the eight and compiles
 * unchanged beside this file. See `../agent/v3.ts` for what "frozen" obliges.
 */

import {
  type FfmpegError,
  type FfmpegRunResult,
  type FfmpegSource,
  isFfmpegError,
  type MediaInfo,
  type MediaStreamInfo,
  probeMedia,
  runFfmpeg,
  transcodeToWav,
  wavEncodeArgs,
} from "../../../host/ffmpeg.ts";

/** What the transcription arithmetic needs: 16 kHz mono linear PCM. */
const WAV = { sampleRate: 16_000, channels: 1 } as const;

/**
 * Bytes or a path, under the name that does not collide with the DOM's.
 *
 * A workflow that reads an upload holds bytes; one cutting a long recording
 * holds a path. Both are the same argument, which is the whole reason this type
 * has a name.
 */
export async function inspect(source: FfmpegSource): Promise<{
  info: MediaInfo;
  audio: MediaStreamInfo | undefined;
  isPcm: boolean;
}> {
  "use step";

  const info = await probeMedia(source);
  return { info, audio: info.audio, isPcm: info.audio?.codec === "pcm_s16le" };
}

/** The conversion, skipped when it would be a no-op. */
export async function normalize(bytes: Uint8Array): Promise<Uint8Array> {
  "use step";

  const { isPcm } = await inspect(bytes);
  return isPcm ? bytes : await transcodeToWav(bytes, { ...WAV, timeoutMs: 60_000 });
}

/**
 * The same conversion file → file, which is the shape for a recording too long
 * to hold in memory — and the reason `wavEncodeArgs` is exported at all.
 */
export async function normalizeFile(input: string, output: string): Promise<FfmpegRunResult> {
  "use step";

  return await runFfmpeg([
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    input,
    ...wavEncodeArgs(WAV),
    output,
  ]);
}

/**
 * Why the failure carries a `kind`: a timeout deserves another attempt and a
 * file ffmpeg refuses to decode never will.
 */
export async function convertOrExplain(bytes: Uint8Array): Promise<Uint8Array | string> {
  "use step";

  try {
    return await transcodeToWav(bytes, WAV);
  } catch (err: unknown) {
    if (!isFfmpegError(err)) throw err;
    const failure: FfmpegError = err;
    if (failure.kind === "timeout" || failure.kind === "aborted") throw failure;
    return `that recording could not be converted: ${failure.stderr}`;
  }
}
