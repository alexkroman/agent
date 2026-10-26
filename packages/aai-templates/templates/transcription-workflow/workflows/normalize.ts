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
 * `transcodeUpload` on `@alexkroman1/aai/step-files` is what replaces it:
 * materialize the upload to a temp file, run ffmpeg over it, store what it
 * wrote, with the verdict (`throwFfmpegStepError`) and the empty-output refusal
 * already applied. Its module doc carries the whole argument (a pipe cannot
 * seek, so an `.m4a` with a trailing `moov` index fails; piped output is capped
 * at 64 MiB, half an hour of this desk's audio) plus the rule that a temp file
 * may not outlive its step. `probe: true` runs ffprobe over the SAME
 * materialized file, before the transcode, and hands what it found to `args` —
 * which is how the encode targets can depend on the source's rate without a
 * second read of the recording.
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
 *
 * A TYPE off the same subpath is not a name in that sense: `import type` is
 * erased before anything is bundled, so {@link audioTrack} and
 * {@link encodeTargets} sit at module scope — which is what makes the two
 * decisions this step makes about a probed file testable without ffmpeg.
 */

import { basename, extname } from "node:path";
import type { MediaInfo, MediaStreamInfo, WavEncodeOptions } from "@alexkroman1/aai/ffmpeg";
import { describeMedia, wavEncodeArgs } from "@alexkroman1/aai/ffmpeg";
import {
  stepReadUpload,
  stepReport,
  stepRequireCompleteUpload,
  UploadIncompleteError,
  type UploadInfo,
} from "@alexkroman1/aai/step";
import { throwFatalStepError } from "@alexkroman1/aai/step-errors";
import { transcodeUpload } from "@alexkroman1/aai/step-files";
import { formatBytes } from "@alexkroman1/aai/utils";
import {
  heavierThanNormalizedFormat,
  NORMALIZED_CHANNELS,
  NORMALIZED_SAMPLE_RATE,
} from "./downsample.ts";
import { assertCuttable, HEADER_PROBE_BYTES, parseWav, UnsupportedRecordingError } from "./wav.ts";

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
  // `requireWholeRecording`, not `stepUploadInfo`: `size` is the readable PREFIX, and
  // every judgement below — cuttable, heavier-per-second, the byte count copied to
  // disk — is about the WHOLE file.
  const stored = await requireWholeRecording(uploadId);
  const head = await stepReadUpload(uploadId, { end: HEADER_PROBE_BYTES });

  if (cuttable(head.bytes, stored.size) && !heavierThanNormalized(head.bytes, stored.size)) {
    // No subprocess, no copy, no second upload. The overwhelmingly common case
    // for a desk whose form says WAV, and the reason the check is a 64 KB read.
    await stepReport(`${stored.label} is already linear-PCM WAV — cutting it as it is.`);
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
  await stepReport(
    `Converting ${stored.label} (${formatBytes(stored.size)}) — ` +
      (cuttable(head.bytes, stored.size)
        ? `heavier per second than ${NORMALIZED_SAMPLE_RATE / 1000} kHz mono.`
        : "not a WAV we can cut."),
  );

  // One materialization, one probe over it, one ffmpeg run, one store — and a
  // temp directory whose lifetime is the call, failure paths included: a
  // guest's disk is small and a step that leaves a copy of every recording it
  // touched fills it. The standing flags (`-nostdin` among them) are the SDK's.
  let targets: ReturnType<typeof encodeTargets> | undefined;
  const written = await transcodeUpload(uploadId, {
    // What it WAS, for the progress line AND for the targets: the `MediaInfo`
    // is read twice, and the second read is the newer one — what to encode to
    // is a function of what came in (`encodeTargets`). Probed on the temp file
    // rather than a pipe, so a trailing index is readable.
    probe: true,
    args: (source, out, info) => {
      targets = encodeTargets(audioTrack(info));
      return ["-i", source, ...wavEncodeArgs(targets), out];
    },
    output: {
      // Named after the ORIGINAL, so a download reads as the recording it came
      // from. The extension has to change with the bytes: a file served as
      // `audio/wav` under a `.m4a` name is one no player will open.
      name: `${basename(stored.label, extname(stored.label))}.wav`,
      type: "audio/wav",
    },
    timeoutMs: CONVERT_TIMEOUT_MS,
  });

  // "41 minutes of aac" explains the shape of the run, where "converted the
  // recording" leaves a reader wondering what the desk decided.
  await stepReport(
    `It was ${written.info === undefined ? "a recording" : describeMedia(written.info)} — ` +
      `re-encoded to ${formatBytes(written.size)} of ` +
      `${(targets?.sampleRate ?? NORMALIZED_SAMPLE_RATE) / 1000} kHz mono WAV ` +
      `(from ${formatBytes(stored.size)}).`,
  );
  return { recording: written.id, converted: true };
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
    // `assertCuttable` as well as the parse: the SDK's parser answers whether
    // this is READABLE WAV, and this desk additionally refuses a rate dense
    // enough that its segments would blow the sync endpoint's request cap.
    // That second half is exactly what downsampling repairs, which is why this
    // question has to include it.
    assertCuttable(parseWav(head, totalBytes));
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

/**
 * The recording, refused unless every byte of it has landed.
 *
 * `stepRequireCompleteUpload` already refuses — it raises
 * {@link UploadIncompleteError}, whose `retryable = false` the engine reads as
 * terminal — so what this adds is the SENTENCE, and it is the mirror of the one
 * `planStreamed` raises next door: that flow refuses a WAV declaring no length
 * and names `transcribe`, and this one refuses a recording still arriving and
 * names `transcribeStream`. A desk offering three flows over one file owes a
 * refusal that says which of the other two to use.
 *
 * Both whole-file steps go through it — this one and `splitRecording` — so the
 * two cannot drift into two different explanations of one state.
 *
 * Exported for that second caller and for its spec.
 */
export async function requireWholeRecording(uploadId: string): Promise<UploadInfo> {
  try {
    return await stepRequireCompleteUpload(uploadId);
  } catch (err: unknown) {
    if (!(err instanceof UploadIncompleteError)) throw err;
    // `err.stored` is what HAS arrived, which is the number that tells a reader
    // whether the uploader died early or nearly finished.
    return throwFatalStepError(
      err,
      `${uploadId} is still uploading — ${formatBytes(err.stored)} of it has arrived. This flow ` +
        "cuts the whole file, so it needs all of it; use the `transcribeStream` workflow to " +
        "transcribe a recording while it is still on its way.",
    );
  }
}

/**
 * The audio stream ffmpeg will read, or a terminal refusal if there is none.
 *
 * A public form takes whatever anyone drops on it, and a screen recording with
 * the microphone off is a real file with real video and nothing to transcribe.
 * Without this the desk copies the whole recording to disk and hands it to
 * ffmpeg, which refuses with `Output file #0 does not contain any stream` —
 * true, terminal, and about ffmpeg's argv rather than about the file the person
 * chose.
 *
 * `MediaInfo.audio` is the FIRST audio stream. ffmpeg's own default selection
 * prefers the WIDEST one, so a file carrying several could be read here and
 * encoded there from two different streams — which costs at most a lower
 * {@link encodeTargets} ceiling, never a wrong file, because that target is a
 * `Math.min`. Recordings with two audio tracks are rare enough not to pay for
 * an explicit `-map` and the mismatch it would then have to explain.
 */
export function audioTrack(info: MediaInfo | undefined): MediaStreamInfo {
  return (
    info?.audio ??
    throwFatalStepError(
      new UnsupportedRecordingError(
        "That file has no audio track, so there is nothing in it to transcribe.",
      ),
    )
  );
}

/**
 * What to re-encode a recording TO, given what it is.
 *
 * Mono at {@link NORMALIZED_SAMPLE_RATE}, except that the rate is a CEILING and
 * never a target — which is the rule `downsample.ts`'s `requestFormat` states
 * for one segment ("Never UP") and which this side used to contradict. A fixed
 * `sampleRate: NORMALIZED_SAMPLE_RATE` upsampled 8 kHz telephony audio to
 * 16 kHz: twice the bytes per request, against an endpoint whose budget is a
 * 30-second wall clock covering the upload, for information the source does not
 * contain. The two are one decision now, so a file converted here and a window
 * `transcribeSegment` resamples on its way out are priced the same way — which
 * is also what `segmentConcurrency` divides to get the fan-out's width.
 *
 * A source ffprobe reported no rate for falls back to the ceiling, which is what
 * the desk asked for before it looked.
 */
export function encodeTargets(
  track: Pick<MediaStreamInfo, "sampleRate">,
): Required<Pick<WavEncodeOptions, "sampleRate" | "channels">> {
  return {
    sampleRate: Math.min(track.sampleRate ?? NORMALIZED_SAMPLE_RATE, NORMALIZED_SAMPLE_RATE),
    channels: NORMALIZED_CHANNELS,
  };
}
