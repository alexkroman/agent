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
 * The fast path costs one 64 KB read and no subprocess at all: a WAV that was
 * already cuttable is returned by the id it came in under, so nothing is copied
 * and nothing is re-encoded.
 *
 * ## File → file, not bytes → bytes
 *
 * `transcodeToWav(bytes)` is one line and is the wrong call here, twice over:
 *
 * - **The output would be buffered.** Piped stdout is capped
 *   (`DEFAULT_MAX_FFMPEG_OUTPUT_BYTES`, 64 MiB), which is about an hour of
 *   16 kHz mono — and this desk exists for the two-hour recording.
 * - **The input could not be READ.** A pipe cannot seek, and an `.m4a` written
 *   by a phone usually carries its `moov` index at the END of the file, so
 *   ffmpeg fails on the flagship input with `moov atom not found`. That is the
 *   one caveat `@alexkroman1/aai/ffmpeg`'s own doc names, and this is the case
 *   it names it for.
 *
 * So the recording is materialized to a temp file in windows, converted file to
 * file, and streamed back into the upload store. Nothing here holds a whole
 * recording in memory at any point, which is the property that makes the step
 * work on the input it was written for.
 *
 * ## A temp file cannot cross a step boundary
 *
 * Everything above happens in ONE step, and that is structural rather than
 * tidy. A step is journaled by its RETURN VALUE and may be dispatched into a
 * different process than its neighbours, so a path in a return value is a path
 * that is replayed after the file behind it is gone. What crosses the boundary
 * is an upload ID; the temp directory is created and removed inside the step
 * that uses it.
 *
 * ## The verdict lives in another file, and has to
 *
 * `classifyFfmpeg` reads as if it belongs beside the step that calls it, and it
 * cannot: a name this module holds at MODULE scope keeps its import, and the
 * workflow bundle — a `node:vm` Script with no `require` — cannot load one that
 * spawns a child process. `ffmpeg-verdict.ts` carries the argument in full.
 */

import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { probeMedia, runFfmpeg, wavEncodeArgs } from "@alexkroman1/aai/ffmpeg";
import { readUpload, report, uploadInfo, writeUpload } from "@alexkroman1/aai/step";
import { classifyFfmpeg } from "./ffmpeg-verdict.ts";
import { clock } from "./stitch.ts";
import { HEADER_PROBE_BYTES, parseWav, UnsupportedRecordingError } from "./wav.ts";

/**
 * The rate everything is converted TO.
 *
 * 16 kHz because that is what speech models are trained at — a higher rate
 * carries no information the decoder uses and costs proportional bytes in a
 * fan-out whose width is bounded by bytes in flight (`BYTES_IN_FLIGHT` in
 * `transcribe.ts`). A converted two-hour recording is 230 MB of 16 kHz mono
 * against 1.4 GB of 48 kHz stereo, which is the difference between a fan-out
 * that saturates on width and one that saturates on the queue.
 */
export const NORMALIZED_SAMPLE_RATE = 16_000;

/**
 * Channels everything is converted TO.
 *
 * Mono, and it is a real loss rather than a free win: a stereo call recording
 * with one party per channel is exactly the file where the channels are the most
 * interesting thing about it, and downmixing throws that away. This desk
 * transcribes rather than diarizes, so it takes the 2x saving; a desk that wants
 * the speakers apart splits the channels first and transcribes each one.
 */
export const NORMALIZED_CHANNELS = 1;

/**
 * Bytes moved per `readUpload` while materializing, and per write while storing.
 *
 * 8 MiB is large enough that a two-hour recording is a few hundred round trips
 * rather than tens of thousands, and small enough that the step's resident set
 * is a constant that does not depend on the recording. The number this must NOT
 * be is "the whole file", which is the shape every first draft of this step has.
 */
const WINDOW_BYTES = 8 * 1024 * 1024;

/**
 * How long a conversion may run before it is killed.
 *
 * Well past what the work takes — ffmpeg decodes and resamples faster than
 * realtime by two orders of magnitude, so a two-hour recording is under a
 * minute — and the reason for a bound at all is a file that makes a decoder
 * pathological rather than one that is merely long. A `timeout` is retryable
 * and an `exit` is not; see `ffmpeg-verdict.ts`.
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
  "use step";

  const stored = await uploadInfo(uploadId);
  const head = await readUpload(uploadId, { end: HEADER_PROBE_BYTES });

  if (cuttable(head.bytes, stored.size)) {
    // No subprocess, no copy, no second upload. The overwhelmingly common case
    // for a desk whose form says WAV, and the reason the check is a 64 KB read.
    await report(`${stored.name || uploadId} is already linear-PCM WAV — cutting it as it is.`);
    return { recording: uploadId, converted: false };
  }

  // Named before any work starts, because everything below is minutes of it on a
  // long recording and a run that says nothing until the conversion finishes looks
  // stuck. It is also the line that distinguishes "this file needs converting" from
  // the fast path above.
  await report(
    `Converting ${stored.name || uploadId} (${mb(stored.size)}) — not a WAV we can cut.`,
  );

  const dir = await mkdtemp(join(tmpdir(), "aai-normalize-"));
  try {
    const source = join(dir, "source");
    const converted = join(dir, "converted.wav");

    await materialize(uploadId, stored.size, source);

    // What it WAS, for the progress line. Worth one ffprobe: "converted 41
    // minutes of aac" is a line that explains the run's shape, where
    // "converted the recording" leaves a reader wondering what the desk decided.
    // On a temp file rather than a pipe, so a trailing index is readable.
    const info = await probeMedia(source, { timeoutMs: CONVERT_TIMEOUT_MS }).catch(classifyFfmpeg);
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
    ).catch(classifyFfmpeg);

    const written = await writeUpload(chunks(converted), {
      // Named after the ORIGINAL, so a download reads as the recording it came
      // from. The extension has to change with the bytes: a file served as
      // `audio/wav` under a `.m4a` name is one no player will open.
      name: `${basename(stored.name || uploadId, extname(stored.name || uploadId))}.wav`,
      type: "audio/wav",
    });

    await report(`Converted to ${mb(written.size)} of WAV (from ${mb(stored.size)}).`);
    return { recording: written.id, converted: true };
  } finally {
    // Always, including on the failure paths above: a guest's disk is small and
    // a step that leaves a copy of every recording it touched fills it. `force`
    // so a conversion that never created its output does not fail HERE and
    // replace the real error with this one.
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Retries beyond the default 3.
 *
 * Not because a conversion is flaky — a corrupt file fails identically forever,
 * and `classifyFfmpeg` is what stops the DevKit retrying that. It is the
 * two I/O halves that are worth another attempt: this step reads a whole
 * recording out of the store and writes a whole one back, and either can lose a
 * connection on a file this size.
 */
normalizeRecording.maxRetries = 5;

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
 * Write an upload to a local path, a window at a time.
 *
 * The `readUpload` window is the same primitive `transcribeSegment` cuts with;
 * what differs is only that this one walks the whole file in order. A `for` loop
 * rather than a fan-out deliberately — the bytes land in one file at one offset
 * each, so concurrency buys nothing here and costs the memory the windows are
 * there to bound.
 */
async function materialize(uploadId: string, size: number, path: string): Promise<void> {
  const handle = await open(path, "w");
  try {
    for (let at = 0; at < size; at += WINDOW_BYTES) {
      const slice = await readUpload(uploadId, {
        start: at,
        end: Math.min(at + WINDOW_BYTES, size),
      });
      await handle.write(slice.bytes);
    }
  } finally {
    await handle.close();
  }
}

/**
 * A local file as the stream `writeUpload` takes.
 *
 * A generator rather than `readFile`, for the reason the windows exist: the
 * converted WAV is the largest thing this step touches, and handing the store an
 * `AsyncIterable` is what keeps it off the heap.
 *
 * The `.slice()` is load-bearing. One buffer is reused across reads, so yielding
 * a view of it hands the consumer memory the next read overwrites — a bug whose
 * symptom is a stored file made of the LAST chunk repeated, and which does not
 * reproduce whenever the consumer happens to copy before the next iteration.
 */
async function* chunks(path: string): AsyncIterable<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(WINDOW_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead).slice();
    }
  } finally {
    await handle.close();
  }
}

/** `41:20 of aac`, or as much of that as ffprobe would say. */
function describeSource(codec: string | undefined, durationSec: number | undefined): string {
  const length = durationSec === undefined ? undefined : clock(Math.round(durationSec * 1000));
  if (length !== undefined && codec !== undefined) return `${length} of ${codec}`;
  return length ?? codec ?? "the recording";
}

/** A size a person can read, because the number that matters is the scale. */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
