// Copyright 2026 the AAI authors. MIT license.
/**
 * `transcodeUpload()` — one upload through ffmpeg and back into the store, as
 * the one step every media pipeline starts with.
 *
 * `step-files.ts` gives a step the three moves (materialize, run, store) and
 * its module doc shows them composed; this is that composition with the parts
 * a copy gets wrong already decided. Every template that re-encoded a recording
 * wrote it, and the four copies disagreed on exactly those parts: whether the
 * standing ffmpeg flags were passed (one forgot `-nostdin`, which in a guest is
 * a process that never exits), whether the failure was classified before the
 * engine saw it (two retried a corrupt file until the budget ran out), and
 * whether an output ffmpeg wrote nothing to was stored anyway (one stored a
 * zero-byte WAV and the next step reported "no speech").
 *
 * ```ts
 * import { wavEncodeArgs } from "@alexkroman1/aai/ffmpeg";
 * import { transcodeUpload } from "@alexkroman1/aai/step-files";
 *
 * export async function toWav(uploadId: string): Promise<string> {
 *   const out = await transcodeUpload(uploadId, {
 *     args: (source, out) => ["-i", source, ...wavEncodeArgs({ sampleRate: 16_000, channels: 1 }), out],
 *     output: { name: "audio.wav", type: "audio/wav" },
 *   });
 *   return out.id;
 * }
 * ```
 *
 * ## One materialization, whatever the step asks for
 *
 * The recording is read out of the store ONCE, and the probe, when asked for,
 * runs over the same file the transcode reads — BEFORE it, so the argv may be
 * built from what the probe found. On a deployed guest the read is
 * the expensive leg by an order of magnitude (`FFMPEG-CLAUDE.md` in the
 * templates package carries the measurement), which is why `probe` is an option
 * here rather than a separate step a body calls first: a body that probed in one
 * step and transcoded in the next paid for the file twice.
 *
 * ## The verdict is applied here, and it is ffmpeg's
 *
 * The run goes through `throwFfmpegStepError` (`@alexkroman1/aai/step-errors`):
 * an exit is FATAL — ffmpeg read the file and refused it, and three more
 * attempts read the same bytes — while a timeout or an abort stays retryable.
 * That classifier is in `sdk/` and this module is in `host/`, and the reason the
 * two are on different subpaths is the same reason this composition can name
 * both: a `workflows/` module may hold a Node-reaching import at module scope
 * (`packages/aai-templates/FFMPEG-CLAUDE.md`), and this is one.
 *
 * @module step-files-transcode
 */

import { extname, join } from "node:path";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { throwFfmpegStepError } from "../sdk/step-errors.ts";
import { stepRequireCompleteUpload } from "../sdk/step-uploads-complete.ts";
import { runFfmpegToUpload } from "./_ffmpeg-to-upload.ts";
import { type MediaInfo, probeMedia } from "./ffmpeg.ts";
import { readUploadToFile, withTempDir } from "./step-files.ts";

/**
 * What {@link transcodeUpload} accepts.
 *
 * @input
 * @public
 */
export type TranscodeUploadOptions = {
  /**
   * The argv AFTER the standing flags — `-i <source>`, the filter and encoder
   * flags, and `<out>` last — given the two paths this call chose and, when
   * `probe` was asked for, what ffprobe made of the source: an argv that
   * depends on the probed rate or channel count reads `info` rather than
   * probing again in a step of its own.
   *
   * `ffmpegBaseArgs()` (`-hide_banner -loglevel error -nostats -nostdin -y`)
   * is prepended by this call and is not the caller's to spell: `-nostdin` is
   * the flag whose absence is a hung process in a guest, and it was the one
   * most often left out. A filter that reports through the LOG needs
   * `loglevel: "info"` instead.
   */
  args: (source: string, out: string, info: MediaInfo | undefined) => readonly string[];
  /**
   * What to store the result as. Both fields are stored verbatim and neither is
   * inferred (`writeUploadFromFile` says why `type` matters); the name's
   * EXTENSION also names the output file ffmpeg writes, which is how ffmpeg
   * picks a container when the argv names no `-f`.
   */
  output: { name: string; type: string };
  /** Wall-clock budget for the ffmpeg run. Defaults to `DEFAULT_FFMPEG_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
  /**
   * Also run `ffprobe` over the materialized source FIRST, hand its
   * {@link MediaInfo} to `args`, and answer it as `info`. Off by default — a
   * probe is a second subprocess, and most transcodes do not need to know what
   * they were handed.
   */
  probe?: boolean | undefined;
  /** `ffmpegBaseArgs`'s `loglevel`. Defaults to `"error"`. */
  loglevel?: string | undefined;
  /** Kill the run when this aborts. Combined with `timeoutMs`, not replaced by it. */
  signal?: AbortSignal | undefined;
};

/**
 * What {@link transcodeUpload} resolves with — a step's whole return value, so
 * everything here survives the journal.
 *
 * @sealed
 * @public
 */
export type TranscodedUpload = {
  /** The stored output's id, as `writeUploadFromFile` minted it. */
  id: string;
  /** The stored output's size in bytes. */
  size: number;
  /** How many bytes of the SOURCE were materialized — the recording's size. */
  bytes: number;
  /** What ffprobe made of the source, when `probe` was asked for. */
  info?: MediaInfo;
  /** Wall-clock milliseconds the ffmpeg run took. */
  ffmpegMs: number;
  /** The tail of ffmpeg's log, on success too: it carries the encode summary. */
  stderr: string;
};

/**
 * Read an upload to a temp file, run ffmpeg over it, and store what it wrote.
 *
 * @param uploadId - An upload in the agent's own store. Must be complete — one
 *   still arriving is refused before anything is read, as `readUploadToFile`
 *   refuses it.
 * @param options - See {@link TranscodeUploadOptions}.
 *
 * @throws {FatalError} on an ffmpeg exit, a missing binary, an output past the
 *   cap, or an output ffmpeg wrote nothing to; {@link RetryableError}-shaped
 *   (the `FfmpegError` unchanged) on a timeout or an abort — `throwFfmpegStepError`'s
 *   verdict, which its doc argues.
 * @throws {UploadIncompleteError} when the upload is still arriving.
 *
 * @public
 */
export async function transcodeUpload(
  uploadId: string,
  options: TranscodeUploadOptions,
): Promise<TranscodedUpload> {
  // The record first, for its label and extension: the refusal of an unfinished
  // upload lands here, before a temp directory exists, and the source keeps the
  // extension the uploader gave so ffmpeg's demuxer has the hint it would have
  // had on disk.
  const stored = await stepRequireCompleteUpload(uploadId);
  return await withTempDir(async (dir) => {
    const source = join(dir, `source${extname(stored.name)}`);
    const out = join(dir, `output${extname(options.output.name)}`);
    const bytes = await readUploadToFile(uploadId, source);
    const info =
      options.probe === true
        ? await probeMedia(source, omitUndefined({ signal: options.signal })).catch(
            throwFfmpegStepError,
          )
        : undefined;
    // The run, the empty-output refusal and the store are `_ffmpeg-to-upload.ts`'s,
    // shared with `stepSpeakToUpload`.
    const { upload, run } = await runFfmpegToUpload(options.args(source, out, info), {
      dir,
      out,
      output: options.output,
      label: stored.label,
      inputBytes: bytes,
      loglevel: options.loglevel,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    return {
      id: upload.id,
      size: upload.size,
      bytes,
      ...omitUndefined({ info }),
      ffmpegMs: run.durationMs,
      stderr: run.stderr,
    };
  });
}
