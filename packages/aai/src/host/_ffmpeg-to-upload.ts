// Copyright 2026 the AAI authors. MIT license.
/**
 * The leg `transcodeUpload` and `stepSpeakToUpload` share: run ffmpeg over a
 * file in a temp directory, refuse an output it wrote nothing to, and store
 * what it wrote.
 *
 * The empty-output refusal is the part a second copy lost. `transcodeUpload`
 * had it (a zero exit over `-vn` on a video-only file is ffmpeg saying "no
 * stream matched", and storing the result hands the next step a file that
 * reads as silence); the speak path, written later as the same three moves,
 * stored whatever the encoder left behind. One function, so the rule holds on
 * both and a third composition starts with it.
 *
 * Internal (`_`-prefixed): the two compositions above are the surface.
 *
 * @module _ffmpeg-to-upload
 */

import { stat } from "node:fs/promises";
import { formatBytes } from "../sdk/format.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { throwFatalStepError, throwFfmpegStepError } from "../sdk/step-errors.ts";
import type { UploadInfo } from "../sdk/step-uploads.ts";
import type { FfmpegRunResult } from "./_ffmpeg-spawn.ts";
import { ffmpegBaseArgs, runFfmpeg } from "./ffmpeg.ts";
import { writeUploadFromFile } from "./step-files.ts";

/** What {@link runFfmpegToUpload} needs beside the argv. */
export type FfmpegToUploadOptions = {
  /** The temp directory the run works in — the child's `cwd`. */
  dir: string;
  /** The path the argv writes; stat'd after the run and stored. */
  out: string;
  /** What to store the output as, verbatim (`writeUploadFromFile` says why `type` matters). */
  output: { name: string; type: string };
  /** How the failure messages name the source — the upload's label, the spoken text's. */
  label: string;
  /** How many bytes went in, for the empty-output message. */
  inputBytes: number;
  /** `ffmpegBaseArgs`'s `loglevel`. Defaults to `"error"`. */
  loglevel?: string | undefined;
  /** Wall-clock budget for the run. Defaults to `DEFAULT_FFMPEG_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
  /** Kill the run when this aborts. Combined with `timeoutMs`, not replaced by it. */
  signal?: AbortSignal | undefined;
};

/**
 * `ffmpegBaseArgs()` + `args` through ffmpeg, the verdict applied, an empty
 * `out` refused as fatal, and `out` stored — answering the record and the run.
 *
 * @throws {FatalError} on an ffmpeg exit, a missing binary, or an output
 *   ffmpeg wrote nothing to; the `FfmpegError` unchanged on a timeout or an
 *   abort (`throwFfmpegStepError`'s verdict).
 */
export async function runFfmpegToUpload(
  args: readonly string[],
  options: FfmpegToUploadOptions,
): Promise<{ upload: UploadInfo; run: FfmpegRunResult }> {
  const { dir, out, output, label, inputBytes } = options;
  const run = await runFfmpeg(
    [...ffmpegBaseArgs(omitUndefined({ loglevel: options.loglevel })), ...args],
    { cwd: dir, ...omitUndefined({ timeoutMs: options.timeoutMs, signal: options.signal }) },
  ).catch(throwFfmpegStepError);
  // A zero exit with an empty output is ffmpeg saying "no stream matched the
  // request" — `-vn` over a video-only file, a filter that dropped everything.
  // Storing it hands the next step a file that reads as silence, which is the
  // failure that is hardest to tell from a real one. Fatal, for the reason an
  // exit is: the same argv over the same bytes writes the same nothing.
  const written = await stat(out).catch((err: unknown) =>
    throwFatalStepError(err, `ffmpeg exited 0 but wrote no ${output.name} for ${label}.`),
  );
  if (written.size === 0) {
    throwFatalStepError(
      new Error(run.stderr),
      `ffmpeg wrote an empty ${output.name} for ${label} (${formatBytes(inputBytes)} in).`,
    );
  }
  const upload = await writeUploadFromFile(out, output);
  return { upload, run };
}
