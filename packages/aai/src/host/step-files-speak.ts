// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepSpeakToUpload()` — speak a text and STORE it, in one step, optionally
 * mastered to MP3.
 *
 * `stepSpeak` answers a WAV and `stepWriteUpload` stores bytes; the shipped
 * `spoken-summary-workflow` composes the two in one step for the reason its
 * guide gives — a step is journaled by its RETURN VALUE, so an id is replayed
 * and audio is not, and split in two the WAV crosses the queue on every resume.
 * What that template could not do is hand a page an MP3: 24 kHz PCM16 is 48 KB
 * a second, so a ten-minute digest is a 29 MB download, and the mastering step
 * needs ffmpeg, which `@alexkroman1/aai/step` may not name. This is the same
 * composition one subpath over, with the encoder in reach.
 *
 * ```ts
 * import { stepSpeakToUpload } from "@alexkroman1/aai/step-files";
 *
 * export async function narrate(script: string): Promise<{ audio: string; durationMs: number }> {
 *   const stored = await stepSpeakToUpload(script, { voice: "aai-jane", master: "mp3", name: "digest.mp3" });
 *   return { audio: stored.id, durationMs: stored.durationMs };
 * }
 * ```
 *
 * `master: "wav"` (the default) stores `stepSpeak`'s WAV as it is and touches
 * no temp file and no subprocess, so a project with no ffmpeg installed pays
 * for it only when it asks for the MP3.
 *
 * @module step-files-speak
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type SpeakOptions, type SpokenAudio, stepSpeak } from "../sdk/step-speak.ts";
import type { UploadInfo } from "../sdk/step-uploads.ts";
import { stepWriteUpload } from "../sdk/step-uploads-write.ts";
import { runFfmpegToUpload } from "./_ffmpeg-to-upload.ts";
import { withTempDir } from "./step-files.ts";

/**
 * The container {@link stepSpeakToUpload} stores.
 *
 * @public
 */
export type SpeakMasterFormat = "mp3" | "wav";

/**
 * What {@link stepSpeakToUpload} masters to: the format alone, or the format
 * with the ffmpeg flags to apply on the way — a `loudnorm` pass, a sample
 * rate, a bitrate — inserted between `-i <source>` and the encoder's own.
 *
 * `format: "wav"` with `args` still runs ffmpeg (the WAV is re-encoded with the
 * flags applied); without `args` it stores `stepSpeak`'s WAV as it is.
 *
 * @input
 * @public
 */
export type SpeakMaster =
  | SpeakMasterFormat
  | {
      format: SpeakMasterFormat;
      /** Filter and encoder flags, e.g. `["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"]`. */
      args?: readonly string[] | undefined;
    };

/**
 * What {@link stepSpeakToUpload} accepts: `stepSpeak`'s options, plus the
 * container and the name to store under.
 *
 * @input
 * @public
 */
export type SpeakToUploadOptions = SpeakOptions & {
  /**
   * `"wav"` stores the synthesized WAV as it is; `"mp3"` masters it with ffmpeg
   * first; the object form adds ffmpeg flags to either. Defaults to `"wav"`.
   */
  master?: SpeakMaster | undefined;
  /**
   * Filename to store, e.g. `"digest.mp3"` — what a page puts on the download
   * link. Required, because the right name depends on `master` and a default
   * that disagreed with it (`summary.wav` holding MPEG frames) is a file a
   * browser will not play.
   */
  name: string;
  /** Wall-clock budget for the mastering run. Defaults to `DEFAULT_FFMPEG_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
};

/**
 * What {@link stepSpeakToUpload} resolves with: the stored record, plus what
 * was spoken.
 *
 * @sealed
 * @public
 */
export type SpokenUpload = UploadInfo & {
  /** How long the audio lasts — `stepSpeak`'s own measurement, from the byte count. */
  durationMs: number;
  /** The voice that actually spoke, with the default filled in. */
  voice: string;
  /** Wall-clock milliseconds the mastering run took — `0` when no ffmpeg ran. */
  ffmpegMs: number;
};

/**
 * The MIME type each master is stored as — the field the byte route serves as
 * `Content-Type`, and the one a browser will not play a file without.
 */
const MASTER_TYPES: Readonly<Record<SpeakMasterFormat, string>> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

/**
 * The encoder flags per format. MP3 at VBR quality 2 (~190 kbps for stereo,
 * less for this mono source): the encoder's own recommended setting for
 * speech that has to survive a phone speaker, and a constant rather than an
 * option because nothing a step knows would change it. A WAV re-encode names
 * no codec: the container decides, and the caller's `args` carry the rest.
 */
const ENCODER_ARGS: Readonly<Record<SpeakMasterFormat, readonly string[]>> = {
  mp3: ["-c:a", "libmp3lame", "-q:a", "2"],
  wav: [],
};

/**
 * Speak `text`, master it, and store it — answering with the record and the
 * duration.
 *
 * @param text - What to say. Refused when blank, as `stepSpeak` refuses it.
 * @param options - See {@link SpeakToUploadOptions}.
 *
 * @throws whatever `stepSpeak` throws (no synthesizer published, no
 *   credential), and for `master: "mp3"` the verdict `throwFfmpegStepError`
 *   reaches on a failed encode — fatal on an exit or a missing binary.
 *
 * @public
 */
export async function stepSpeakToUpload(
  text: string,
  options: SpeakToUploadOptions,
): Promise<SpokenUpload> {
  const { master = "wav", name, timeoutMs, ...speak } = options;
  const { format, args = [] } = typeof master === "string" ? { format: master } : master;
  const spoken = await stepSpeak(text, speak);
  const output = { name, type: MASTER_TYPES[format] };
  const needsFfmpeg = format === "mp3" || args.length > 0;
  const mastered = needsFfmpeg
    ? await masterWav(spoken, [...args, ...ENCODER_ARGS[format]], format, output, timeoutMs)
    : { upload: await stepWriteUpload(spoken.audio, output), ffmpegMs: 0 };
  return {
    ...mastered.upload,
    durationMs: spoken.durationMs,
    voice: spoken.voice,
    ffmpegMs: mastered.ffmpegMs,
  };
}

/**
 * The WAV through ffmpeg and into the store, file → file.
 *
 * A temp file rather than `pipe:0`, even though a WAV is seekable from a pipe,
 * so this and `transcodeUpload` are one shape and the same rule covers both
 * (`_ffmpeg-to-upload.ts`, which also refuses an empty encode); and because the
 * synthesized WAV of a long script is the largest thing this step holds, which
 * the piped output's 64 MiB cap would eventually meet.
 */
async function masterWav(
  spoken: SpokenAudio,
  encode: readonly string[],
  format: SpeakMasterFormat,
  output: { name: string; type: string },
  timeoutMs: number | undefined,
): Promise<{ upload: UploadInfo; ffmpegMs: number }> {
  return await withTempDir(async (dir) => {
    const source = join(dir, "spoken.wav");
    const out = join(dir, `mastered.${format}`);
    await writeFile(source, spoken.audio);
    const { upload, run } = await runFfmpegToUpload(["-i", source, "-vn", ...encode, out], {
      dir,
      out,
      output,
      label: "the spoken audio",
      inputBytes: spoken.audio.byteLength,
      timeoutMs,
    });
    return { upload, ffmpegMs: run.durationMs };
  });
}
