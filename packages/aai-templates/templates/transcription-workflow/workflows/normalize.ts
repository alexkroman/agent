// Copyright 2026 the AAI authors. MIT license.
/**
 * The step that makes the rest of the desk possible on a real file: whatever was
 * uploaded, converted to the one format the arithmetic works on.
 *
 * `wav.ts` explains why this desk cuts linear-PCM WAV and nothing else — a byte
 * offset is only a timestamp when every sample is the same size — and for a long
 * time the remedy for anything else was a SENTENCE telling the caller to run
 * `ffmpeg -i in.m4a -c:a pcm_s16le out.wav` on their own machine first. Every
 * recording anyone actually has is an `.m4a` off a phone or an `.mp3` out of a
 * conferencing tool, so that sentence was the desk's real front door, and it
 * opened onto the user's shell. The platform installs ffmpeg in every guest
 * image; this file is the desk using it.
 *
 * ```text
 *   normalizeRecording   one step   →  an upload id the rest of the flow can cut
 * ```
 *
 * ## `parseWav` is asked as a QUESTION
 *
 * The obvious implementation probes the file with `ffprobe` and passes it
 * through when the codec looks like PCM. It is wrong in a way that only shows up
 * on a Windows recorder's output: a `WAVE_FORMAT_EXTENSIBLE` file reports
 * `pcm_s16le` to ffprobe and is refused by {@link parseWav}, whose encoding
 * check reads the format tag ffprobe does not surface. The desk would convert
 * nothing and then fail to cut it.
 *
 * So the test is {@link parseWav} ITSELF, run against the same
 * {@link HEADER_PROBE_BYTES} window `splitRecording` will use. A throw is the
 * signal to convert. That makes the pass-through decision and the cut decision
 * the same decision by construction — there is no second opinion to disagree —
 * and it means the desk fixes anything the parser rejects for any reason,
 * including a 192 kHz 32-bit stereo WAV that trips
 * {@link MAX_BYTES_PER_SECOND}, which downsampling genuinely repairs.
 *
 * The fast path costs one 64 KB read and no subprocess at all: a WAV that is
 * already cuttable AND already light enough is returned by the id it came in
 * under, so nothing is copied and nothing is re-encoded.
 *
 * ## Cuttable is not the same as worth cutting
 *
 * {@link parseWav} succeeding is necessary and not sufficient. A 48 kHz stereo
 * WAV parses and cuts perfectly and is six times the bytes per request that the
 * same audio is at {@link NORMALIZED_SAMPLE_RATE} mono — which the sync
 * endpoint's 30-second deadline turns from a cost into a failure. So the fast
 * path is gated on {@link heavierThanNormalized} as well, and that predicate's
 * own doc carries the measurement.
 *
 * ## File → file, not bytes → bytes
 *
 * `transcodeToWav(bytes)` is one line and is the wrong call here, and
 * `@alexkroman1/aai/step-files` is the three functions that replace it —
 * `readUploadToFile`, `withTempDir` and `writeUploadFromFile`. Its module doc
 * carries the whole argument (a pipe cannot seek, so an `.m4a` with a trailing
 * `moov` index fails; piped output is capped at 64 MiB, half an hour of this
 * desk's audio) plus the rule that a temp file may not outlive its step. This
 * step is the case those were written for.
 *
 * ## Everything node-shaped is named from inside the step BODY
 *
 * `@alexkroman1/aai/ffmpeg` and `@alexkroman1/aai/step-files` both reach a
 * `node:` builtin, and a name this module holds at MODULE scope keeps its import
 * in the workflow bundle — which is compiled as a `node:vm` Script with no
 * `require`. Every name they bind is referenced only inside
 * {@link normalizeRecording}'s body, which the workflow transform removes along
 * with the imports it is the only user of. A module-scope FUNCTION naming one is
 * what breaks a run at replay; this template used to carry a whole
 * `ffmpeg-verdict.ts` because of it, and `throwFfmpegStepError` — which reaches
 * no `node:` builtin at all — is what dissolved the boundary.
 */

import { basename, extname, join } from "node:path";
import { probeMedia, runFfmpeg, wavEncodeArgs } from "@alexkroman1/aai/ffmpeg";
import { readUpload, report, requireCompleteUpload } from "@alexkroman1/aai/step";
import { throwFfmpegStepError } from "@alexkroman1/aai/step-errors";
import { readUploadToFile, withTempDir, writeUploadFromFile } from "@alexkroman1/aai/step-files";
import { formatBytes, formatDuration } from "@alexkroman1/aai/utils";
import {
  heavierThanNormalizedFormat,
  NORMALIZED_CHANNELS,
  NORMALIZED_SAMPLE_RATE,
} from "./downsample.ts";
import { HEADER_PROBE_BYTES, parseWav, UnsupportedRecordingError } from "./wav.ts";

// Re-exported rather than re-declared: they are still this module's vocabulary —
// the `runFfmpeg` call below converts TO them — and they live in `downsample.ts`
// only because the streaming flow needs them from a module that reaches no
// `node:` builtin. See that file's module doc.
export { NORMALIZED_CHANNELS, NORMALIZED_SAMPLE_RATE } from "./downsample.ts";

/**
 * How long a conversion may run before it is killed.
 *
 * Well past what the work takes — ffmpeg decodes and resamples faster than
 * realtime by two orders of magnitude, so a two-hour recording is under a
 * minute — and the reason for a bound at all is a file that makes a decoder
 * pathological rather than one that is merely long. A `timeout` is retryable
 * and an `exit` is not; `throwFfmpegStepError` decides.
 */
const CONVERT_TIMEOUT_MS = 15 * 60_000;

/** What the flow is handed: the id to cut, and whether it had to be made. */
export type NormalizedRecording = {
  /**
   * The upload id every later step reads.
   *
   * The SAME id that came in when the file was already cuttable, and a new one
   * when it was converted — which is why the flow threads this rather than its
   * own input from here on.
   */
  recording: string;
  /** Whether ffmpeg ran. Reported, so a reader can tell a fast path from a slow one. */
  converted: boolean;
};

/**
 * Make sure the recording is something the desk can cut, converting if not.
 *
 * A step, for the ordinary two reasons — it does I/O, and its RESULT is what
 * every later step addresses — plus one specific to what it produces: the
 * conversion writes a file, and journaling the id means a resumed run reads the
 * file that already exists instead of paying for a second one.
 */
export async function normalizeRecording(uploadId: string): Promise<NormalizedRecording> {
  // `requireCompleteUpload`, not `uploadInfo`: `size` is the readable PREFIX, and
  // every judgement below — cuttable, heavier-per-second, the byte count copied to
  // disk — is about the WHOLE file.
  const stored = await requireCompleteUpload(uploadId);
  const head = await readUpload(uploadId, { end: HEADER_PROBE_BYTES });

  if (cuttable(head.bytes, stored.size) && !heavierThanNormalized(head.bytes, stored.size)) {
    // No subprocess, no copy, no second upload. The overwhelmingly common case
    // for a desk whose form says WAV, and the reason the check is a 64 KB read.
    await report(`${stored.name || uploadId} is already linear-PCM WAV — cutting it as it is.`);
    return { recording: uploadId, converted: false };
  }

  // Named before any work starts, because everything below is minutes of it on a
  // long recording and a run that says nothing until the conversion finishes looks
  // stuck. It is also the line that distinguishes "this file needs converting" from
  // the fast path above.
  // WHY it is being converted, because there are now two reasons and they look
  // nothing alike to a reader watching the log: a file the parser refused, and a
  // WAV that is fine but too heavy to cut at this rate. Reporting "not a WAV we
  // can cut" for the second one is a line that contradicts the file they
  // uploaded.
  await report(
    `Converting ${stored.name || uploadId} (${formatBytes(stored.size)}) — ` +
      (cuttable(head.bytes, stored.size)
        ? `heavier per second than ${NORMALIZED_SAMPLE_RATE / 1000} kHz mono.`
        : "not a WAV we can cut."),
  );

  // The temp directory's lifetime is this lexical scope, and the `finally` inside
  // `withTempDir` is what makes that true on the failure paths too: a guest's disk
  // is small and a step that leaves a copy of every recording it touched fills it.
  return await withTempDir(
    async (dir) => {
      const source = join(dir, "source");
      const converted = join(dir, "converted.wav");

      await readUploadToFile(uploadId, source, { size: stored.size });

      // What it WAS, for the progress line. Worth one ffprobe: "converted 41
      // minutes of aac" is a line that explains the run's shape, where
      // "converted the recording" leaves a reader wondering what the desk decided.
      // On a temp file rather than a pipe, so a trailing index is readable.
      const info = await probeMedia(source, { timeoutMs: CONVERT_TIMEOUT_MS }).catch(
        throwFfmpegStepError,
      );
      await report(
        `It is ${describeSource(info.audio?.codec, info.durationSec)} — re-encoding to ` +
          `${NORMALIZED_SAMPLE_RATE / 1000} kHz mono WAV.`,
      );

      await runFfmpeg(
        [
          // The argv is the caller's, verbatim — `runFfmpeg` adds nothing. So the
          // standing flags are here: quiet, non-interactive, overwrite. `-nostdin`
          // matters most in a guest, where there is no terminal and an ffmpeg that
          // decides to read stdin is a process that never exits.
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-i",
          source,
          ...wavEncodeArgs({
            sampleRate: NORMALIZED_SAMPLE_RATE,
            channels: NORMALIZED_CHANNELS,
          }),
          converted,
        ],
        { timeoutMs: CONVERT_TIMEOUT_MS },
      ).catch(throwFfmpegStepError);

      const written = await writeUploadFromFile(converted, {
        // Named after the ORIGINAL, so a download reads as the recording it came
        // from. The extension has to change with the bytes: a file served as
        // `audio/wav` under a `.m4a` name is one no player will open.
        name: `${basename(stored.name || uploadId, extname(stored.name || uploadId))}.wav`,
        type: "audio/wav",
      });

      await report(
        `Converted to ${formatBytes(written.size)} of WAV (from ${formatBytes(stored.size)}).`,
      );
      return { recording: written.id, converted: true };
    },
    // Named after the pipeline: the directory is gone by the time anyone looks,
    // so the prefix's real audience is a person reading `ls /tmp` during a run
    // that hung, and the spec that asserts nothing was left behind.
    { prefix: "aai-normalize-" },
  );
}

/**
 * Whether `splitRecording` will be able to read this header.
 *
 * The question, not a guess at it — see the module doc. Only
 * {@link UnsupportedRecordingError} is answered `false`: anything else thrown by
 * the parser is a bug in the parser, and swallowing it here would turn that into
 * a mysterious re-encode of a file that was fine.
 */
export function cuttable(head: Uint8Array, totalBytes: number): boolean {
  try {
    parseWav(head, totalBytes);
    return true;
  } catch (err: unknown) {
    if (err instanceof UnsupportedRecordingError) return false;
    throw err;
  }
}

/**
 * Whether cutting this file AS IS would make every request too heavy.
 *
 * {@link cuttable} asks whether `splitRecording` CAN read the header; this asks
 * whether it SHOULD. They are different questions and the answers point opposite
 * ways for one common file: a 48 kHz stereo recording parses perfectly and cuts
 * perfectly, and each 92-second segment of it is 17.7 MB against the 2.94 MB the
 * same segment is once normalized. The sync endpoint deadlines a request at 30s,
 * so six times the upload per request is the difference between segments landing
 * in single digits and segments landing at 22-28s — which is not a slow run, it
 * is a run where the first straggler past 30s takes the whole thing down (a
 * segment burns its attempts, the body throws, and every sibling still in flight
 * is discarded and re-billed on the resume).
 *
 * This is NOT the "second opinion" the module doc warns about. That warning is
 * about the pass-through decision disagreeing with the CUT decision — passing
 * through something `splitRecording` then cannot read. This predicate can only
 * ever send MORE files to ffmpeg, never fewer, and what comes back is 16 kHz mono
 * by construction, so the two decisions still cannot disagree.
 *
 * Compared against the normalize targets rather than against a byte budget of its
 * own: the question is literally "would converting make this smaller", and
 * anything at or below {@link NORMALIZED_SAMPLE_RATE} / {@link NORMALIZED_CHANNELS}
 * would only be re-encoded into itself. Note this deliberately does NOT look at
 * `bitsPerSample` — `wavEncodeArgs` emits `pcm_s16le`, so a 24- or 32-bit file at
 * 16 kHz mono really would shrink, but that is a 1.5-2x saving on a file already
 * inside the budget, and converting it costs an ffmpeg pass over the whole
 * recording. Revisit if a 32-bit mono source ever shows up in practice.
 *
 * Safe to call only where {@link cuttable} has already answered `true` — it
 * re-parses the same window and a rejected header would throw here rather than
 * answering.
 */
export function heavierThanNormalized(head: Uint8Array, totalBytes: number): boolean {
  return heavierThanNormalizedFormat(parseWav(head, totalBytes));
}

/** `41:20 of aac`, or as much of that as ffprobe would say. */
function describeSource(codec: string | undefined, durationSec: number | undefined): string {
  const length =
    durationSec === undefined ? undefined : formatDuration(Math.round(durationSec * 1000));
  if (length !== undefined && codec !== undefined) return `${length} of ${codec}`;
  return length ?? codec ?? "the recording";
}
