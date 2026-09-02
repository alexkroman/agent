// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the transcription desk: split a recording, transcribe
 * every piece, stitch the pieces back together.
 *
 * Read `research-workflow/workflows/research.ts` first. It states the two rules
 * every directive body obeys — replayed from the top, so no live handles and no
 * undurable decisions; step arguments and return values are serialized, so pass
 * an id and not a payload — and both hold here unchanged. What this template
 * adds is the shape a real provider limit forces on a workflow, and it is four
 * steps in a straight line:
 *
 * ```text
 *   normalizeRecording  one step   →  an upload id in a format that can be cut
 *   splitRecording      one step   →  the format + a byte range per segment
 *   transcribeSegment   N steps    →  one sync API request each, bounded
 *   mergeTranscript     one step   →  the stitched transcript
 * ```
 *
 * The first is the newest and the one a reader is least likely to expect, since
 * everything below it is arithmetic over a WAV and real recordings are not WAVs.
 * `normalize.ts` is where ffmpeg enters, and its module doc carries why the
 * conversion is file-to-file and why a temp file may not outlive its step.
 *
 * ## Why the SYNC endpoint, and why that forces a fan-out
 *
 * AssemblyAI has two pre-recorded APIs. The BATCH one takes a job and a webhook
 * and calls back minutes later, which is the classic durable-workflow shape and
 * is what this template used to demonstrate against a stub. The SYNC one
 * (`https://sync.assemblyai.com/transcribe`) answers in the request — and pays
 * for it with a hard 120-second, 40 MB cap. So a real recording is not one call,
 * it is N; the desk owns the splitting, the retrying and the reassembly that the
 * batch API would have owned for it.
 *
 * That is the more interesting workflow, not the lesser one. A fan-out of N
 * network calls is exactly the work a journal earns its keep on: a run that dies
 * on segment 27 of 60 resumes having replayed 1-26 from the journal — not
 * re-downloaded, not re-transcribed, not re-billed — and issues only what is
 * missing. Nothing about `Promise.all` in a tool body survives the same crash.
 *
 * ## Three properties this leans on
 *
 * - **A step can read the agent's env now.** `stepEnv`/`requireStepEnv`
 *   (`@alexkroman1/aai/step`) is what makes any of this real: a step is
 *   dispatched separately from the agent bundle and is handed no `ToolContext`,
 *   so before that seam existed no step anywhere could authenticate an outbound
 *   call, and every workflow template's I/O was a fixture saying so.
 * - **The audio is addressed by BYTE RANGE, never carried.** A workflow's input
 *   is journaled and replayed on every resume, so the recording lives in the
 *   app's own upload store and the run carries only its id; each step reads
 *   exactly its own window with `readUpload`. Sixty steps therefore move the
 *   recording once between them, not sixty times.
 * - **The fan-out is bounded by `mapConcurrent`, and the bound is not a detail.**
 *   The DevKit correlates a journal entry to a step call by the ORDER the call
 *   was issued in, so the primitive keeps a WINDOW over a cursor that only ever
 *   hands out the next index — the Nth call issued is segment N-1 however the
 *   calls settle. Its module doc carries the argument; what matters here is that
 *   there is no barrier, so a slow segment costs only itself.
 * - **The transcript STREAMS as it is produced.** Each segment is emitted the
 *   moment it lands (`emit(TRANSCRIPT_STREAM, …)`), so the page renders the
 *   answer growing rather than a status line and then everything at once. That is
 *   the difference a fan-out can make to a reader and a run output cannot: an
 *   `output` exists only when the last segment does.
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import {
  emit,
  encodeWav,
  mapConcurrent,
  readUpload,
  report,
  requireCompleteUpload,
  uploadInfo,
} from "@alexkroman1/aai/step";
import { throwFatalStepError } from "@alexkroman1/aai/step-errors";
import { countWords, formatDuration, plural } from "@alexkroman1/aai/utils";
import { downsampleSegment, requestFormat } from "./downsample.ts";
import { normalizeRecording } from "./normalize.ts";
import { stitchTranscript, TRANSCRIPT_STREAM, type TranscriptChunk } from "./stitch.ts";
import { elapsed, timed, transcribeWav } from "./sync-api.ts";
import {
  bytesPerSecond,
  HEADER_PROBE_BYTES,
  parseWav,
  planSegments,
  SEGMENT_OVERLAP_SECONDS,
  SEGMENT_SECONDS,
  type Segment,
  UnsupportedRecordingError,
  type WavFormat,
} from "./wav.ts";

/**
 * Bytes the desk keeps uploading at once, which is what {@link segmentConcurrency}
 * divides to get a width.
 *
 * A `503` from this endpoint says `queue wait timed out; server at capacity`, and
 * that sentence is the whole model: requests are QUEUED rather than refused, and one
 * fails only when it waited out the queue's own deadline. So what limits the fan-out
 * is total work in flight, and at this segment length that is dominated by BYTES —
 * not by the request count and not by the audio duration. Five arms, one account, one
 * laptop, `curl` straight at the endpoint:
 *
 * | requests | per request | bytes in flight | audio-s | `503`s |
 * | --- | --- | --- | --- | --- |
 * | 320 | 160 KB (5s) | 51 MB | 1,600 | 0 |
 * | 64 | 2.94 MB (92s, 16 kHz mono) | 188 MB | 5,888 | 0 |
 * | 48 | 17.66 MB (92s, 48 kHz stereo) | 848 MB | 4,416 | 0 |
 * | 56 | 17.66 MB | 989 MB | 5,152 | 6 |
 * | 64 | 17.66 MB | 1.13 GB | 5,888 | 20 |
 * | 320 | 2.94 MB | 941 MB | 29,440 | 64 |
 *
 * Read the columns against each other, because each one rules something out. Request
 * COUNT cannot be the cap: 320 tiny requests were admitted whole, and so were 64 at
 * 2.94 MB, where a flat ceiling of ~50 would have refused the excess. Audio DURATION
 * cannot be it either: 5,888 audio-seconds passed cleanly at 2.94 MB a request and
 * drew 20 `503`s at 17.66 MB — same audio, six times the bytes. What tracks is the
 * byte column, and it tracks in ADMITTED bytes too, tightly, across request counts
 * that differ by 5x: 848 MB clean, then 883 MB / 777 MB / 753 MB admitted on the
 * three arms that limited. The last row is the proof, since it reaches the same
 * ceiling with 320 small requests as 64 big ones do.
 *
 * 640 MB sits between the largest clean run (848 MB) and the smallest limited one
 * (941 MB), nearer the clean side. It is the declared quantity because the WIDTH is
 * not the durable fact — this desk cuts whatever format it is handed, and the same
 * 32 segments are 565 MB of 48 kHz stereo, 94 MB of 16 kHz mono, or 1.28 GB of a
 * format at the {@link MAX_SEGMENT_BYTES} ceiling. Only one of those three is safe,
 * and a constant cannot tell them apart.
 *
 * The threshold is this machine's, and one caveat sharpens which half. Bytes in
 * flight is bytes UPLOADING, so it is also the number that saturated a ~65 MB/s
 * uplink — a deployed guest reserving one CPU has neither, and a slower uplink holds
 * every request open LONGER, which is the direction that makes a queue deadline
 * easier to hit rather than harder. Re-measure there.
 */
export const BYTES_IN_FLIGHT = 640 * 1024 * 1024;

/**
 * The widest fan-out, however small the segments are.
 *
 * Because {@link BYTES_IN_FLIGHT} stops being the binding constraint once segments
 * are small — 16 kHz mono would divide out to 173 — and the endpoint's own tail
 * takes over before that helps: p95/p50 measured 1.1x at 20 concurrent against
 * 1.5x at 320, with max/p50 reaching 6.7x (5.2s against 35.0s). A `503` carrying
 * `retry-after: 1` is exactly such a straggler.
 *
 * **That tail used to be paid once per ROUND, and is not any more.** `mapConcurrent`
 * was `mapInBatches` — sequential batches of `Promise.all` — so a batch's wall time
 * was its slowest member and a run's was the sum of those. It is a window over a
 * cursor now: a straggler holds up nothing but itself, and the numbers below were
 * measured under the old barrier, so they are if anything pessimistic.
 *
 * 32 is the measured knee over 65 segments (1h37m of 48 kHz stereo), one concurrency
 * per run, through this workflow:
 *
 * | in flight | wall | vs realtime | `503`s |
 * | --- | --- | --- | --- |
 * | 8 | 43.3s | 134x | 0 |
 * | 32 | 27.5s | 211x | 0 |
 * | 48 | 26.1-28.5s | 204-223x | 0-4 |
 * | 64 | 31.9s | 182x | 20 |
 *
 * This was 8 for a long time, which cost 37% of the wall clock for headroom the
 * endpoint does not need. Past 32 there is nothing left to buy: 48 is within noise
 * of it while starting to pay retries, and 64 is outright SLOWER. Note the width is
 * also inert below a threshold — at 90-second segments, 32 only binds past 48
 * minutes of audio — so on a typical recording the whole fan-out is in flight
 * either way and this number changes nothing.
 *
 * The table above was measured under the old per-round barrier. Re-measuring it is
 * worth doing before this number moves again: the window makes a wide fan-out
 * cheaper at the tail, which if anything argues for a HIGHER knee. *
 * **What EXECUTES at this width is the engine's call, not this number's.**
 * `mapConcurrent` bounds how many step calls the body has in flight; how many
 * run at once is `DEFAULT_STEP_CONCURRENCY` (`aai-runtime`), which is **16** —
 * measured against a real microVM at Modal's guaranteed reservation, where a
 * concurrent segment of 48 kHz stereo costs 26.1 MB. So a width above 16 is
 * inert on a stock deployment while still costing a queued job per item, and
 * this number is the FAR SIDE's knee: the one to use once an operator has
 * raised `AAI_WORKFLOW_STEP_CONCURRENCY` for a larger guest. It was three,
 * inherited from graphile-worker and never measured, which made every number
 * in the table above unreachable. See "The WINDOW is not the concurrency" in
 * `@alexkroman1/aai/step`'s `mapConcurrent`; the numbers above were measured
 * against the endpoint and say nothing about that layer.
 */
export const MAX_SEGMENT_CONCURRENCY = 32;

/**
 * How many segments of THIS recording to keep in flight.
 *
 * Derived rather than declared, because the byte cost of a segment is a property of
 * the format and not of this code: see {@link BYTES_IN_FLIGHT} for the measurements,
 * and note that a fixed 32 is safe for 48 kHz stereo and a guaranteed queue timeout
 * for a format twice as heavy. Both flows call this, so both scale the same way.
 *
 * Safe to call from a workflow BODY: `format` arrives from a journaled step result,
 * so a replay derives the same width from the same bytes — which is what keeps
 * `mapConcurrent` issuing its calls in the order the journal recorded them.
 *
 * Overshooting stays recoverable whatever this returns: a `503` carries
 * `retry-after` and `toStepError` below honours it, so the run completes having paid
 * one extra request per limited segment (measured: 20 `503`s at 64, each retried
 * exactly once, run completed). That is only true over HTTP/1.1, which is what
 * `stepFetch` pins.
 */
export function segmentConcurrency(format: WavFormat): number {
  // The format that will be SENT, not the one that was cut. The budget is bytes
  // UPLOADING and `transcribeSegment` normalizes each window first, so asking the
  // source format would price a 48 kHz stereo segment at 17.66 MB when 2.94 MB
  // goes on the wire — six times too cautious, and drifting the moment either
  // side of that pair changes. Both derive it from `requestFormat`.
  const perSegment =
    bytesPerSecond(requestFormat(format)) * (SEGMENT_SECONDS + SEGMENT_OVERLAP_SECONDS);
  if (perSegment <= 0) return MAX_SEGMENT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_SEGMENT_CONCURRENCY, Math.floor(BYTES_IN_FLIGHT / perSegment)));
}

/**
 * What a finished run reports, whichever flow produced it.
 *
 * Declared once and shared by all three, because the page renders any of them with
 * one component: a field added to one flow and not the others is a panel that shows
 * it for some runs and not others, with nothing saying why.
 */
export type Transcript = {
  /** The recording's own filename, so a reader knows which run they are looking at. */
  source: string;
  /** How many requests the transcript was assembled from. `1` for the async flow. */
  segments: number;
  /** Length of the AUDIO. */
  durationMs: number;
  /** How long the RUN took, wall clock. The number that compares the flows. */
  elapsedMs: number;
  words: number;
  transcript: string;
};

/** What one segment's request came back with — the STEP's result, journaled. */
export type SegmentTranscript = {
  index: number;
  text: string;
};

/**
 * Transcribe a recording and return one transcript.
 *
 * The input is what `POST /workflows/runs` carries — see `agent.ts` for the
 * schema it is validated against before a run exists.
 */
export async function transcribeFlow(input: { recording: string }, ctx: WorkflowCtx) {
  // Both at once: neither needs the other, and issued together they are one
  // round trip instead of two before any audio is read. The ORDER is still a
  // pure function of this line — the two calls go out synchronously, left to
  // right — which is what a replay reproduces.
  //
  // The clock starts before the conversion rather than after it, because a
  // reader comparing the three flows over one file is comparing what the desk
  // COST them, and re-encoding an m4a is part of that.
  // `maxAttempts: 6` was `normalizeRecording.maxRetries = 5`. More than the
  // default 3, and not because a conversion is flaky — a corrupt file fails
  // identically forever, and `throwFfmpegStepError` is what stops the engine
  // retrying that. It is the two I/O halves that are worth another attempt: this
  // step reads a whole recording out of the store and writes a whole one back.
  const [startedAt, ready] = await Promise.all([
    ctx.now(),
    ctx.step("normalizeRecording", () => normalizeRecording(input.recording), { maxAttempts: 6 }),
  ]);

  // `ready.recording` from here on, not `input.recording`: a converted file is a
  // DIFFERENT upload, and cutting the original by offsets planned against the
  // converted one is a fan-out of garbage that still reports success.
  const plan = await ctx.step("splitRecording", () => splitRecording(ready.recording));

  // One step per segment, bounded, in an order a replay reproduces exactly.
  // A failed segment fails the RUN, deliberately: every sibling that finished is
  // already journaled, so the resume replays those for free and re-issues only
  // what is missing, where catching here to salvage a partial transcript would
  // return a recording with a silent hole in it and report success.
  const parts = await mapConcurrent(plan.segments, segmentConcurrency(plan.format), (segment) =>
    // `maxAttempts: 6` was `transcribeSegment.maxRetries = 5` — more than the
    // default 3 because a rate limit is the expected failure here, and a segment
    // that 429s is not a segment that is wrong.
    ctx.step("transcribeSegment", () => transcribeSegment(ready.recording, plan.format, segment), {
      maxAttempts: 6,
    }),
  );

  // The ORIGINAL id, and only here: `mergeTranscript` uses it for the filename a
  // reader sees, and `standup.m4a` is the recording they uploaded — where the
  // converted copy is an artifact of how the desk works.
  return await ctx.step("mergeTranscript", () =>
    mergeTranscript(input.recording, plan.durationMs, parts, startedAt),
  );
}

/**
 * Read the recording's header and decide where to cut it.
 *
 * A step rather than body code for two reasons that both matter. It does I/O,
 * which a body may not; and its RESULT is what the fan-out's width is derived
 * from, so journaling it is what makes that width stable across a resume — the
 * body re-derives the same segment list from the same journaled format rather
 * than re-probing a URL whose content may have changed underneath it.
 */
export async function splitRecording(uploadId: string): Promise<{
  format: WavFormat;
  segments: Segment[];
  durationMs: number;
}> {
  // The whole file, refused if it is still arriving. `info.size` is the readable
  // PREFIX, and it is what the segment plan's width is derived from — so against a
  // half-arrived recording this planned a fan-out over the first half and the run
  // returned a transcript of it, reporting success. `stream.ts` is the flow for a
  // recording that is still landing; this one wants all of it.
  const stored = await requireCompleteUpload(uploadId);
  const head = await readUpload(uploadId, { end: HEADER_PROBE_BYTES });
  const format = fatalOnUnsupported(() => parseWav(head.bytes, stored.size));
  const segments = fatalOnUnsupported(() => planSegments(format));
  const durationMs = segments.at(-1)?.endMs ?? 0;

  await report(
    `Split ${formatDuration(durationMs)} of audio into ${segments.length} ${plural(segments.length, "segment")}.`,
  );
  return { format, segments, durationMs };
}

/**
 * Transcribe one segment through the sync API.
 *
 * One step each, so a run that dies part-way resumes having replayed the
 * finished ones from the journal — no re-downloading, no re-billing — and issues
 * exactly the calls that are missing.
 */
export async function transcribeSegment(
  uploadId: string,
  format: WavFormat,
  segment: Segment,
): Promise<SegmentTranscript> {
  // One line per segment, which is what makes the fan-out legible to a page: the
  // status is `running` for the whole thing, so without this a sixty-segment
  // recording and a one-segment recording look identical while they run.
  //
  // ORDER is not guaranteed here and does not need to be. A batch issues its
  // calls together, so their lines interleave by completion — the page renders a
  // log, not a sequence, and `segment.index` is what puts the TRANSCRIPT back in
  // order.
  await report(`Transcribing ${formatDuration(segment.startMs)}–${formatDuration(segment.endMs)}.`);

  // `[start, end)`, the same half-open pair `planSegments` produced — the store
  // owns the conversion to HTTP's inclusive range, so there is no `- 1` here to
  // get wrong.
  const audio = await readUpload(uploadId, { start: segment.start, end: segment.end });

  // The audio and nothing else. A `config` part carrying `language_code` used
  // to ride along, and it is gone with the picker that fed it: the model detects
  // the language, so the field was a question asked of a person that the service
  // answers better — and getting it wrong is a whole transcript in the wrong
  // language. Add one back only for a desk that really knows.
  //
  // `encodeWav` is what makes a WINDOW decodable: the endpoint decodes each
  // request independently, so a slice of the middle of a recording is a headerless
  // tail until one is put back on it. The streaming flow needs no equivalent — its
  // parts were cut with a header each. The header is the SDK's rather than this
  // template's: a `WavFormat` is structurally a `PcmFormat`, and 22 lines of
  // `DataView` writes with a comment about which of the two declared lengths a
  // decoder trusts is not a thing worth a second copy of.
  // Down to 16 kHz mono BEFORE the header goes on, because the endpoint's budget
  // is 30 seconds of wall clock and that covers the upload. At 48 kHz stereo this
  // window is 17.66 MB and the same audio is 2.94 MB normalized — six times the
  // bytes against a fixed deadline, which is what turns a slow segment into a
  // `504 request exceeded 30.0s` and then into a failed run. Inert on the classic
  // flow, where `normalizeRecording` already converted the whole file; see
  // `downsample.ts` for why the streaming flow cannot do the same.
  //
  // Through `fatalOnUnsupported` for the same reason `planStreamed` reads its
  // header through it: `parseWav` admits any bit depth whose block align is
  // positive, and `downsampleSegment` can serve only four of them — so a
  // recording the desk could cut but cannot send raises
  // `UnsupportedRecordingError` here, and a plain throw would spend all six
  // attempts re-reading this window out of the upload store to arrive at the
  // identical answer. BOTH flows can reach it, which is newer than it looks:
  // the check used to hang off the resampler, so a 12-bit recording already at
  // 16 kHz mono — light for both flows, and therefore converted by neither —
  // sailed past it into an unclassified `RangeError` from `encodeWav`.
  const light = fatalOnUnsupported(() => downsampleSegment(audio.bytes, format));

  const { value: text, ms } = await timed(() =>
    transcribeWav(
      encodeWav(light.bytes, light.format),
      `segment-${segment.index}.wav`,
      `Segment ${segment.index} (${formatDuration(segment.startMs)})`,
    ),
  );
  // The LATENCY, which is what says whether the concurrency bound or the endpoint
  // is the thing limiting the run — see `timed`'s doc.
  await report(
    `Transcribed ${formatDuration(segment.startMs)}–${formatDuration(segment.endMs)} in ${elapsed(ms)}.`,
  );
  // And the WORDS, into their own stream, which is what makes this run's answer
  // streamable rather than only its narration: the page stitches whatever has
  // arrived and renders the transcript growing, minutes before `output` exists.
  // Its own namespace because `report`'s stream carries sentences a page prints
  // verbatim — see `emit`'s doc.
  await emit(TRANSCRIPT_STREAM, {
    index: segment.index,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text,
  } satisfies TranscriptChunk);
  return { index: segment.index, text };
}

/**
 * Stitch the segments into one transcript.
 *
 * A step rather than a pure call in the body, and the reason is the narration:
 * the body replays from the top on every resume, so a `report()` written there
 * is re-emitted on each one. Journaling the finished transcript also means a
 * caller re-reading a completed run gets the same bytes rather than a value
 * recomputed from parts.
 */
export async function mergeTranscript(
  uploadId: string,
  durationMs: number,
  parts: readonly SegmentTranscript[],
  startedAt: number,
): Promise<Transcript> {
  await report(`Stitching ${parts.length} ${plural(parts.length, "segment")} together.`);

  // `mapConcurrent` resolves in ITEM order however the calls settled, so this is
  // already ordered — sorted anyway, because the merge is where an ordering
  // mistake would be invisible rather than loud.
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  const transcript = stitchTranscript(ordered.map((part) => part.text));

  // The FILENAME, not the id: the page prints this, and `upl_9f3…` tells a
  // reader nothing about which recording they are looking at.
  const source = (await uploadInfo(uploadId)).name || uploadId;
  return {
    source,
    segments: parts.length,
    durationMs,
    // Wall clock, so the three flows can be compared over one file. Legal HERE
    // and not in the body: a step's internals are not replayed, only its result.
    // `startedAt` is the body's `ctx.now()`, journaled by the engine.
    elapsedMs: Date.now() - startedAt,
    words: countWords(transcript),
    transcript,
  };
}

// Re-exported rather than re-declared: `stream.ts` and `batch.ts` already import
// these from this module, and the split that let the PAGE stitch a partial
// transcript should not ripple through every flow. `clock` and `countWords` used
// to be in this list and are `formatDuration`/`countWords` on
// `@alexkroman1/aai/utils` now — a run narrates itself and the page renders the
// same run, so those two were a private copy of a formatter the SDK ships.
export {
  stitchChunks,
  stitchTranscript,
  TRANSCRIPT_STREAM,
  type TranscriptChunk,
} from "./stitch.ts";

// ---- I/O helpers ------------------------------------------------------------

/**
 * Run a `wav.ts` helper, turning its "cannot cut this" into a terminal failure.
 *
 * Exported because `stream.ts` plans with the same `wav.ts` helpers and owes the
 * same classification, and it had this byte for byte.
 */
export function fatalOnUnsupported<T>(read: () => T): T {
  try {
    return read();
  } catch (err: unknown) {
    if (err instanceof UnsupportedRecordingError) return throwFatalStepError(err);
    throw err;
  }
}
