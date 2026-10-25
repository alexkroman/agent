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
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { throwFfmpegStepError } from "../sdk/step-errors.ts";
import { type SpeakOptions, type SpokenAudio, stepSpeak } from "../sdk/step-speak.ts";
import type { UploadInfo } from "../sdk/step-uploads.ts";
import { stepWriteUpload } from "../sdk/step-uploads-write.ts";
import { ffmpegBaseArgs, runFfmpeg } from "./ffmpeg.ts";
import { withTempDir, writeUploadFromFile } from "./step-files.ts";

/**
 * The container {@link stepSpeakToUpload} stores.
 *
 * @public
 */
export type SpeakMaster = "mp3" | "wav";

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
   * first. Defaults to `"wav"`.
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
};

/**
 * The MIME type each master is stored as — the field the byte route serves as
 * `Content-Type`, and the one a browser will not play a file without.
 */
const MASTER_TYPES: Readonly<Record<SpeakMaster, string>> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
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
  const spoken = await stepSpeak(text, speak);
  const stored =
    master === "mp3"
      ? await masterToMp3(spoken, { name, type: MASTER_TYPES.mp3 }, timeoutMs)
      : await stepWriteUpload(spoken.audio, { name, type: MASTER_TYPES.wav });
  return { ...stored, durationMs: spoken.durationMs, voice: spoken.voice };
}

/**
 * The WAV through `libmp3lame` and into the store, file → file.
 *
 * A temp file rather than `pipe:0`, even though a WAV is seekable from a pipe,
 * so this and `transcodeUpload` are one shape and the same rule covers both; and
 * because the synthesized WAV of a long script is the largest thing this step
 * holds, which the piped output's 64 MiB cap would eventually meet.
 */
async function masterToMp3(
  spoken: SpokenAudio,
  output: { name: string; type: string },
  timeoutMs: number | undefined,
): Promise<UploadInfo> {
  return await withTempDir(async (dir) => {
    const source = join(dir, "spoken.wav");
    const out = join(dir, "mastered.mp3");
    await writeFile(source, spoken.audio);
    // VBR quality 2 (~190 kbps for stereo, less for this mono source): the
    // encoder's own recommended setting for speech that has to survive a phone
    // speaker, and a constant rather than an option because nothing a step
    // knows would change it.
    await runFfmpeg(
      [...ffmpegBaseArgs(), "-i", source, "-vn", "-c:a", "libmp3lame", "-q:a", "2", out],
      { cwd: dir, ...omitUndefined({ timeoutMs }) },
    ).catch(throwFfmpegStepError);
    return await writeUploadFromFile(out, output);
  });
}
