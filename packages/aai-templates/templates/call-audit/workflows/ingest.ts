// Copyright 2026 the AAI authors. MIT license.
/**
 * The step where ffmpeg turns an arbitrary recording into something the rest of
 * the desk can reason about.
 *
 * ```text
 *   materialize   the upload → a temp file   (windowed, nothing on the heap)
 *   probe         ffprobe                    → what it WAS
 *   measure       loudnorm pass one          → five numbers
 *   normalize     loudnorm pass two          → levelled raw PCM + every pause
 *   store         the PCM → an upload        (streamed)
 * ```
 *
 * Five things, ONE step, and that is the decision in this file worth arguing
 * about — so here is the argument.
 *
 * ## Why not five steps
 *
 * Splitting steps buys a cheaper retry: a failure re-runs one stage instead of
 * five. It costs a MATERIALIZATION each, because a temp file cannot cross a step
 * boundary (see `@alexkroman1/aai/step-files`) — so a five-step version reads the whole
 * recording out of the upload store five times, and on a 700 MB file that is the
 * expensive part by an order of magnitude. The decode passes are cheap: ffmpeg
 * resamples two orders of magnitude faster than realtime, so a two-hour recording
 * is seconds of CPU.
 *
 * The retry it would buy is also mostly imaginary. The stages here fail together:
 * a corrupt file fails the probe and would have failed both passes, and a
 * conversion that ran out of time re-runs from the beginning anyway. The one
 * genuine case — pass two failing after pass one succeeded — is a `timeout`,
 * which is exactly the case a retry re-does wholesale.
 *
 * So: one materialization, three invocations, one journal entry. What that entry
 * holds is an upload id and some numbers, which is the rule this template obeys
 * everywhere — a step is replayed by its return value, so bytes must never be in
 * one.
 *
 * ## The two analyses come back by different routes
 *
 * `media.ts`'s module doc carries this in full, and it is the single most
 * surprising thing about the file: loudness arrives on **stderr** (one block,
 * printed last, so a capped tail holds it) and the pauses arrive in a **file**
 * (one event per pause, so their size grows with the recording and a tail would
 * silently drop the earliest ones). Both are read here.
 *
 * ## Everything ffmpeg-shaped is named from inside the step BODY
 *
 * `@alexkroman1/aai/ffmpeg` and `@alexkroman1/aai/step-files` both reach a
 * `node:` builtin, and a name this module holds at MODULE scope keeps its import
 * in the workflow bundle — which is compiled as a `node:vm` Script with no
 * `require`. The import statements are at the top, as the SDK's own examples
 * write them, and every name they bind is referenced only inside
 * {@link ingestRecording}'s body, which the workflow transform removes along
 * with the imports it is the only user of. A module-scope FUNCTION naming one is
 * what breaks a run at replay; this template used to carry a whole
 * `ffmpeg-verdict.ts` because of it, and `throwFfmpegStepError` — which reaches
 * no `node:` builtin at all — is what dissolved the boundary.
 *
 * `analyse` stays here for the other half of that rule: everything IT names is
 * pure, so it may survive into the bundle.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { probeMedia, runFfmpeg } from "@alexkroman1/aai/ffmpeg";
import { pcmDurationMs, stepReport, stepRequireCompleteUpload } from "@alexkroman1/aai/step";
import { throwFatalStepError, throwFfmpegStepError } from "@alexkroman1/aai/step-errors";
import { readUploadToFile, withTempDir, writeUploadFromFile } from "@alexkroman1/aai/step-files";
import { formatBytes, formatDuration, plural } from "@alexkroman1/aai/utils";
import {
  ANALYSIS_FORMAT,
  type Loudness,
  MediaAnalysisError,
  measureLoudnessArgs,
  normalizeArgs,
  parseLoudness,
  parseSilences,
  type Silence,
  speechFraction,
} from "./media.ts";

/**
 * How long any one ffmpeg invocation may run before it is killed.
 *
 * Well past what the work takes, because the reason for a bound at all is a file
 * that makes a decoder pathological rather than one that is merely long. A
 * `timeout` is retryable and an `exit` is not; `throwFfmpegStepError` decides.
 */
const FFMPEG_TIMEOUT_MS = 20 * 60_000;

/** What the ingest step hands the rest of the run. Numbers and an id — never bytes. */
export type Ingested = {
  /**
   * Upload id of the normalized audio: headerless raw PCM in
   * {@link ANALYSIS_FORMAT}.
   *
   * Every later step addresses this rather than the caller's file, and reads it
   * by byte range. Because it has no header, byte zero is second zero.
   */
  audio: string;
  /** The uploaded file's own name, so a reader knows which run they are looking at. */
  source: string;
  /** What ffprobe made of the original — `aac`, `mp3`, `pcm_s16le`. */
  codec: string;
  /** Length of the audio, measured from the PCM byte count rather than from a header. */
  durationMs: number;
  /** Size of the normalized PCM. */
  bytes: number;
  /** What the recording measured before it was levelled. */
  loudness: Loudness;
  /** Every pause long enough to cut in. The fan-out's cut points come from these. */
  silences: Silence[];
};

/**
 * Convert, level, and map the pauses in the recording.
 *
 * A step for the ordinary two reasons — it does I/O, and its RESULT is what
 * everything later addresses — plus one that is specific to what it produces: the
 * normalization writes a file, so journaling the id means a resumed run reads the
 * file that already exists instead of paying to make a second one.
 */
// This file sits in `scripts/coverage-per-file-baseline.json` at 46.8%, and the
// reason is worth having in place. What is uncovered is `ingestRecording`'s HAPPY
// path — three ffmpeg invocations — which needs a real binary and so belongs to
// the scenario tier, not here; the two failure paths ARE covered, and every
// decision the step makes lives in `media.ts` as a pure function at 95%.
//
// It measured exactly 50.0% before the DevKit removal, and the two statements it
// lost were `"use step";` and `ingestRecording.maxRetries = 5;` — both of which
// the two failure tests EXECUTED, so both counted as covered while testing
// nothing. Removing them is what took the file under the floor: a directive
// propping a coverage number up is the least useful statement in the tree.
export async function ingestRecording(uploadId: string): Promise<Ingested> {
  // `stepRequireCompleteUpload`, not `stepUploadInfo`: `size` is the readable PREFIX, so
  // an upload still arriving would be copied short and levelled as the whole call.
  const stored = await stepRequireCompleteUpload(uploadId);
  await stepReport(`Reading ${stored.name || uploadId} (${formatBytes(stored.size)}).`);

  return await withTempDir(
    async (dir) => {
      const source = join(dir, "source");
      const normalized = join(dir, "audio.pcm");
      const silenceLog = join(dir, "silence.txt");

      // NO `size`, though `stored.size` is right there — and that is the whole
      // difference between this copy being one window at a time and being
      // `STEP_FILE_READ_CONCURRENCY` of them. Passing `size` means "I am judging
      // completeness myself", which is what a body polling a still-arriving
      // upload needs and is the opposite of what happened above: this step has
      // already called `stepRequireCompleteUpload`, so the file IS whole and the
      // windows may land in any order. Omitting it lets `readUploadToFile`
      // establish that for itself and fan out. The cost is one metadata round
      // trip, against the dozens of window reads it overlaps.
      await readUploadToFile(uploadId, source);

      // What it WAS, for the progress log and the page. Worth one ffprobe: "41
      // minutes of aac" explains the shape of the run, where "the recording" leaves
      // a reader guessing what the desk decided. On a temp FILE rather than a pipe,
      // so a trailing index is readable.
      const probed = await probeMedia(source, { timeoutMs: FFMPEG_TIMEOUT_MS }).catch(
        throwFfmpegStepError,
      );
      const codec = probed.audio?.codec ?? "unknown";
      await stepReport(
        `Levelling ${describeSource(codec, probed.durationSec)} to ${ANALYSIS_FORMAT.sampleRate / 1000} kHz mono.`,
      );

      // Pass one: measure. `-f null -` decodes every frame and writes no audio, so
      // this costs a decode and produces five numbers.
      const measured = await runFfmpeg(measureLoudnessArgs(source), {
        timeoutMs: FFMPEG_TIMEOUT_MS,
      }).catch(throwFfmpegStepError);
      const loudness = analyse(() => parseLoudness(measured.stderr));

      // Pass two: apply the measurement, find the pauses, write the audio.
      await runFfmpeg(normalizeArgs(source, loudness, normalized, silenceLog), {
        timeoutMs: FFMPEG_TIMEOUT_MS,
      }).catch(throwFfmpegStepError);

      // The duration comes from the BYTE COUNT, not from the original's header or
      // from ffprobe. It is the only measurement that agrees with the byte offsets
      // the fan-out will use — a container's declared duration can disagree with
      // what was actually decoded (an AAC file's encoder padding puts this one ~16ms
      // over), and a segment planned against the wrong one runs off the end.
      const bytes = (await stat(normalized)).size;
      const durationMs = pcmDurationMs(bytes, ANALYSIS_FORMAT);

      // Verified on ffmpeg 6.1: `ametadata` creates the file at filter-init, so a
      // recording with no pause in it leaves an EMPTY log rather than no log. A
      // missing file here is therefore a real failure and not a case to tolerate.
      const log = await readFile(silenceLog, "utf-8");
      const silences = analyse(() => parseSilences(log, durationMs / 1000));

      const written = await writeUploadFromFile(normalized, {
        // Named after the original, so a download reads as the recording it came
        // from. `.pcm` because that is what it is — raw samples with no header, and
        // a `.wav` name on a headerless file is one no player will open.
        name: `${baseName(stored.name || uploadId)}.pcm`,
        // Not `audio/wav`: the type is served back on the byte route, and claiming a
        // container this file does not have would be a lie a browser acts on. Not
        // `audio/L16` either, which looks right and is not — that type is defined as
        // BIG-endian 16-bit PCM, where this is `s16le`. Nothing plays this file; the
        // fan-out reads byte ranges out of it and puts a real header back on each one
        // with `encodeWav`.
        type: "application/octet-stream",
      });

      await stepReport(
        `Levelled ${formatDuration(durationMs)} from ${loudness.inputLufs} LUFS, ` +
          `${Math.round(speechFraction(silences, durationMs / 1000) * 100)}% speech across ` +
          `${silences.length} ${plural(silences.length, "pause")}.`,
      );

      return {
        audio: written.id,
        source: stored.name || uploadId,
        codec,
        durationMs,
        bytes,
        loudness,
        silences,
      };
    },
    { prefix: "aai-call-audit-" },
  );
}

/**
 * Run a `media.ts` reader, turning "I cannot read this analysis" into a terminal
 * failure.
 *
 * Fatal rather than retryable, and the distinction is real: a
 * {@link MediaAnalysisError} means ffmpeg SUCCEEDED and printed something this
 * desk does not understand — a version whose `loudnorm` renamed a key, an argv
 * that lost `-loglevel info`. Every retry runs the same binary with the same argv
 * and prints the same thing, so the retries only delay a person reading the
 * message.
 */
export function analyse<T>(read: () => T): T {
  try {
    return read();
  } catch (err: unknown) {
    if (err instanceof MediaAnalysisError) return throwFatalStepError(err);
    throw err;
  }
}

/** `41:20 of aac`, or as much of that as ffprobe would say. */
function describeSource(codec: string, durationSec: number | undefined): string {
  const length =
    durationSec === undefined ? undefined : formatDuration(Math.round(durationSec * 1000));
  return length === undefined ? codec : `${length} of ${codec}`;
}

/** A filename without its extension, so a new one can be put on. */
function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
