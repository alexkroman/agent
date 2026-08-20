// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:ffmpeg` epoch 1.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 *
 * The shape a media pipeline is written in: probe what arrived, convert it if it
 * is not already the format the arithmetic needs, and classify a failure so a
 * corrupt file is not retried forever. The `"use step"` directives are inert
 * here — nothing compiles this through the Workflow DevKit's builder — which is
 * the point: what is frozen is the way an author WRITES against these helpers,
 * and the only thing this must keep doing is compile.
 */

import {
  type FfmpegError,
  type FfmpegRunResult,
  isFfmpegError,
  type MediaInfo,
  probeMedia,
  runFfmpeg,
  transcodeToWav,
  wavEncodeArgs,
} from "../../../host/ffmpeg.ts";

/** What the transcription arithmetic needs: 16 kHz mono linear PCM. */
const WAV = { sampleRate: 16_000, channels: 1 } as const;

/** Whether this recording can be cut by byte offset as it stands. */
export async function inspect(bytes: Uint8Array): Promise<{ info: MediaInfo; isPcm: boolean }> {
  "use step";

  const info = await probeMedia(bytes);
  return { info, isPcm: info.audio?.codec === "pcm_s16le" };
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
