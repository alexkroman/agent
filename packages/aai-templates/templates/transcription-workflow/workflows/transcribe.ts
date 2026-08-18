// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the transcription desk: split a recording, transcribe
 * every piece, stitch the pieces back together.
 *
 * Read `research-workflow/workflows/research.ts` first. It states the two rules
 * every directive body obeys — replayed from the top, so no live handles and no
 * undurable decisions; step arguments and return values are serialized, so pass
 * an id and not a payload — and both hold here unchanged. What this template
 * adds is the shape a real provider limit forces on a workflow, and it is three
 * steps in a straight line:
 *
 * ```text
 *   splitRecording      one step   →  the format + a byte range per segment
 *   transcribeSegment   N steps    →  one sync API request each, bounded
 *   mergeTranscript     one step   →  the stitched transcript
 * ```
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
 *   (`@alexkroman1/aai/utils`) is what makes any of this real: a step is
 *   dispatched separately from the agent bundle and is handed no `ToolContext`,
 *   so before that seam existed no step anywhere could authenticate an outbound
 *   call, and every workflow template's I/O was a fixture saying so.
 * - **The audio is addressed by BYTE RANGE, never carried.** A workflow's input
 *   is journaled and replayed on every resume, so the recording lives in the
 *   app's own upload store and the run carries only its id; each step reads
 *   exactly its own window with `readUpload`. Sixty steps therefore move the
 *   recording once between them, not sixty times.
 * - **The fan-out is bounded by `mapInBatches`, and the bound is not a detail.**
 *   The DevKit correlates a journal entry to a step call by the ORDER the call
 *   was issued in, so a work-stealing pool — which issues its next call only
 *   when a previous one settles — puts the calls in a different order on a
 *   replay than it did on the first execution. That primitive is sequential
 *   batches of `Promise.all` for exactly that reason; its module doc carries the
 *   argument.
 */

import { throwFatalStepError } from "@alexkroman1/aai/step-errors";
import { mapInBatches, readUpload, report, uploadInfo } from "@alexkroman1/aai/utils";
import { elapsed, timed, transcribeWav } from "./sync-api.ts";
import {
  parseWav,
  planSegments,
  SEGMENT_OVERLAP_SECONDS,
  SEGMENT_SECONDS,
  type Segment,
  UnsupportedRecordingError,
  type WavFormat,
  wavWithHeader,
} from "./wav.ts";

/**
 * Audio-seconds the desk keeps in flight, which is what {@link SEGMENT_CONCURRENCY}
 * is DERIVED from rather than a request count.
 *
 * The far side's capacity tracks how much audio is being decoded at once, not how
 * many sockets are open, and the two measurements that say so were taken against
 * different payload shapes. 320 concurrent requests of a 5-second clip — 1,600
 * audio-seconds, 51 MB — drew zero `429`s and zero `503`s: the endpoint QUEUES
 * rather than rejecting, and latency grew linearly with depth (p50 0.4s at 5, 1.9s
 * at 80, 5.2s at 320) while throughput plateaued at ~25-30 req/s. But 64 concurrent
 * 92-second segments — 5,888 audio-seconds — drew 20 `503 Capacity Exceeded`, and 48
 * of them (4,416) drew 0-4. A request count cannot explain both; audio-seconds can.
 *
 * 3,000 is under the 4,416 where limiting began and comfortably over the 2,944 that
 * came back clean. Keeping it as the declared quantity is what makes the derivation
 * worth having: lowering {@link SEGMENT_SECONDS} to 30 would otherwise TRIPLE the
 * audio in flight at a fixed concurrency of 32, silently, and the symptom would be
 * `503`s on a change that never mentioned concurrency.
 */
const AUDIO_SECONDS_IN_FLIGHT = 3000;

/**
 * Segments in flight at once — 32 at the segment length above.
 *
 * Bounded because the far side has a capacity limit, and it is MEASURED — 65
 * segments (1h37m of 48 kHz stereo, 17.66 MB each) through this workflow, one
 * concurrency per run, from one laptop and one account:
 *
 * | in flight | wall | vs realtime | `503`s |
 * | --- | --- | --- | --- |
 * | 8 | 43.3s | 134x | 0 |
 * | 32 | 27.5s | 211x | 0 |
 * | 48 | 26.1-28.5s | 204-223x | 0-4 |
 * | 64 | 31.9s | 182x | 20 |
 *
 * 32 is the KNEE and this used to be 8, which cost 37% of the wall clock for
 * headroom the endpoint turns out not to need — see {@link AUDIO_SECONDS_IN_FLIGHT}
 * for the 320-concurrent run that drew no throttling at all. Past 32 there is
 * nothing to buy: 48 is within noise of it while starting to pay retries, and 64 is
 * outright SLOWER than 32.
 *
 * Why the ceiling is real, and it is not the rate limit. `mapInBatches` is a
 * barrier rather than a work-stealing pool — deliberately, because the DevKit
 * correlates a journal entry to a step call by the order the call was issued in — so
 * a batch's wall time is its SLOWEST request, and a run's is the sum of those. Depth
 * widens the tail it therefore pays in full: p95/p50 measured 1.1x at 20 concurrent
 * and 1.5x at 320, with max/p50 reaching 6.7x (5.2s against 35.0s). One straggler
 * stalls every sibling that already finished, and a `503` carrying `retry-after: 1`
 * is exactly such a straggler — which is why overshooting is cheap in BILLING and
 * not in latency.
 *
 * Two things this number does not cover. It is inert below a threshold: at 90-second
 * segments, 32 only binds past 48 minutes of audio, so for a typical recording the
 * whole fan-out is in flight either way. And the plateau belongs to the machine,
 * not to this code — a deployed guest reserves one CPU and has neither this uplink
 * nor its ~47 MB/s, and at 17.66 MB a segment, 32 in flight is 565 MB of concurrent
 * upload. Re-measure there before trusting it; the symptom of getting it wrong on a
 * guest is latency, not an error. Overshooting stays SAFE either way: a `503` carries
 * `retry-after` and `toStepError` below honours it, so the run completes having paid
 * one extra request per limited segment (measured: 20 `503`s at 64, each retried
 * exactly once, run completed). That is only true over HTTP/1.1, which is what
 * `stepFetch` pins.
 */
export const SEGMENT_CONCURRENCY = Math.floor(
  AUDIO_SECONDS_IN_FLIGHT / (SEGMENT_SECONDS + SEGMENT_OVERLAP_SECONDS),
);

/**
 * Bytes probed for the WAV header.
 *
 * The canonical header is 44 bytes; a recorder that writes a `LIST` or `bext`
 * chunk in front of the samples pushes the `data` chunk further out, and 64 KB
 * covers every such file anyone has produced by accident.
 */
const HEADER_PROBE_BYTES = 64 * 1024;

/** Most words `stitchTranscript` will look back over to find a repeated seam. */
const MAX_SEAM_WORDS = 40;

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

/** What one segment's request came back with. */
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
export async function transcribeFlow(input: { recording: string }) {
  "use workflow";

  const startedAt = await startClock();
  const plan = await splitRecording(input.recording);

  // One step per segment, bounded, in an order a replay reproduces exactly.
  // A failed segment fails the RUN, deliberately: every sibling that finished is
  // already journaled, so the resume replays those for free and re-issues only
  // what is missing, where catching here to salvage a partial transcript would
  // return a recording with a silent hole in it and report success.
  const parts = await mapInBatches(plan.segments, SEGMENT_CONCURRENCY, (segment) =>
    transcribeSegment(input.recording, plan.format, segment),
  );

  // Whatever this returns is what a caller reads as `output` on a completed run
  // — so it is what the page renders, typed through `WorkflowOutputOf`.
  return await mergeTranscript(input.recording, plan.durationMs, parts, startedAt);
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
  "use step";

  const head = await readUpload(uploadId, { end: HEADER_PROBE_BYTES });
  const format = fatalOnUnsupported(() => parseWav(head.bytes, head.info.size));
  const segments = fatalOnUnsupported(() => planSegments(format));
  const durationMs = segments.at(-1)?.endMs ?? 0;

  await report(
    `Split ${clock(durationMs)} of audio into ${segments.length} segment${segments.length === 1 ? "" : "s"}.`,
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
  "use step";

  // One line per segment, which is what makes the fan-out legible to a page: the
  // status is `running` for the whole thing, so without this a sixty-segment
  // recording and a one-segment recording look identical while they run.
  //
  // ORDER is not guaranteed here and does not need to be. A batch issues its
  // calls together, so their lines interleave by completion — the page renders a
  // log, not a sequence, and `segment.index` is what puts the TRANSCRIPT back in
  // order.
  await report(`Transcribing ${clock(segment.startMs)}–${clock(segment.endMs)}.`);

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
  // `wavWithHeader` is what makes a WINDOW decodable: the endpoint decodes each
  // request independently, so a slice of the middle of a recording is a headerless
  // tail until one is put back on it. The streaming flow needs no equivalent — its
  // parts were cut with a header each.
  const { value: text, ms } = await timed(() =>
    transcribeWav(
      wavWithHeader(format, audio.bytes),
      `segment-${segment.index}.wav`,
      `Segment ${segment.index} (${clock(segment.startMs)})`,
    ),
  );
  // The LATENCY, which is what says whether the concurrency bound or the endpoint
  // is the thing limiting the run — see `timed`'s doc.
  await report(`Transcribed ${clock(segment.startMs)}–${clock(segment.endMs)} in ${elapsed(ms)}.`);
  return { index: segment.index, text };
}

/**
 * Retries beyond the default 3, because a rate limit is the expected failure and
 * a segment that 429s is not a segment that is wrong.
 */
transcribeSegment.maxRetries = 5;

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
  "use step";

  await report(`Stitching ${parts.length} segment${parts.length === 1 ? "" : "s"} together.`);

  // `mapInBatches` resolves in ITEM order however the calls settled, so this is
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
    // Wall clock, so the three flows can be compared over one file — see
    // `startClock`. Measured in a STEP, which is what makes it survive a replay.
    elapsedMs: Date.now() - startedAt,
    words: countWords(transcript),
    transcript,
  };
}

// ---- Pure helpers -----------------------------------------------------------

/**
 * When the run started, as epoch ms.
 *
 * A STEP, and that is the whole reason this exists rather than a `Date.now()` in the
 * body: a body replays from the top on every resume, so a clock read there returns a
 * different value each time and every duration derived from it would be a different
 * duration. A step's result is journaled, so this is the moment the run really began
 * however many times it is replayed.
 *
 * Shared by all three flows deliberately. A run snapshot carries `createdAt` and no
 * end time, so "how long did this take" is not answerable from the outside — and the
 * whole point of shipping three flows over one job is that a reader can compare them,
 * which needs one number measured one way.
 */
export async function startClock(): Promise<number> {
  "use step";

  return Date.now();
}

/** A word, stripped of the punctuation the decoder added, for seam comparison. */
function seamKey(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}

/**
 * Join segment transcripts, dropping the words the overlap made duplicates.
 *
 * Segments overlap by `SEGMENT_OVERLAP_SECONDS` (see `wav.ts` for why), so the
 * last few words of one segment are the first few of the next — verbatim when
 * the decoder heard them the same way, which is the common case because it heard
 * the same audio. This finds the longest such run and removes one copy.
 *
 * Comparison is on `seamKey`, not the raw words: the two passes punctuate
 * differently at their own edges (one ends a sentence where the other is
 * mid-clause), so `"today."` and `"today"` are the same word and a raw compare
 * finds no seam at all. The text KEPT is the raw text — only the match is
 * normalized.
 *
 * A missed seam repeats a few words, which a reader can see and forgive. A
 * false one would delete speech, so the search is bounded at
 * `MAX_SEAM_WORDS` and always prefers the LONGEST match: a single repeated
 * "the" is not evidence of anything, and requiring the longest run is what stops
 * it counting as one when a longer match is available.
 */
export function stitchTranscript(parts: readonly string[]): string {
  const merged: string[] = [];
  for (const part of parts) {
    const next = part.split(/\s+/).filter(Boolean);
    if (next.length === 0) continue;
    if (merged.length === 0) {
      merged.push(...next);
      continue;
    }
    merged.push(...next.slice(seamLength(merged, next)));
  }
  return merged.join(" ");
}

/** How many leading words of `next` repeat the tail of `merged`. */
function seamLength(merged: readonly string[], next: readonly string[]): number {
  const limit = Math.min(MAX_SEAM_WORDS, merged.length, next.length);
  // Longest first, so a short accidental match never wins over a real seam.
  for (let length = limit; length > 0; length--) {
    const tail = merged.slice(merged.length - length);
    if (tail.every((word, at) => seamKey(word) === seamKey(next[at] ?? ""))) return length;
  }
  return 0;
}

/** Words in a string. Exported so the streaming flow reports the same number. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** `m:ss` for the progress log — a byte offset means nothing to a reader. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// ---- I/O helpers ------------------------------------------------------------

/** Run a `wav.ts` helper, turning its "cannot cut this" into a terminal failure. */
function fatalOnUnsupported<T>(read: () => T): T {
  try {
    return read();
  } catch (err: unknown) {
    if (err instanceof UnsupportedRecordingError) return throwFatalStepError(err);
    throw err;
  }
}
