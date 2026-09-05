// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow body, and the fan-out it plans.
 *
 * ```text
 *   ctx.now()           journaled  →  when the run began
 *   ingestRecording     one step   →  levelled PCM + every pause   (ingest.ts)
 *   planSegments        the BODY   →  where to cut                 (media.ts, pure)
 *   transcribeSegment   N steps    →  one sync API request each, bounded
 *   summarize           one step   →  headline, risks, actions      (summarize.ts)
 *   narrate             one step   →  an MP3 of the summary         (summarize.ts)
 *   ctx.now()           journaled  →  when it finished
 * ```
 *
 * Read `transcription-workflow` first: it owns the fan-out — why the sync
 * endpoint forces one, how `mapConcurrent` keeps a replay's call order stable,
 * why a segment is addressed by byte range and never carried — and none of that
 * is restated here. **What this template adds is what changes when a DECODER is
 * in the pipeline**, and it is worth reading the two side by side, because the
 * difference is subtraction:
 *
 * | | `transcription-workflow` | here |
 * | --- | --- | --- |
 * | accepts | any audio, converts to WAV | any audio, converts to raw PCM |
 * | header | parsed (`parseWav`, ~180 lines) | **none — byte 0 is second 0** |
 * | cut at | every 90s, wherever that lands | **the middle of a pause** |
 * | overlap | 2s per segment, transcribed twice | **none** |
 * | stitching | seam matching, drops repeated words | **ordered concatenation** |
 * | caps to plan against | 120s AND 40 MB, whichever binds | **120s** |
 * | levelling | none | `loudnorm`, two-pass |
 *
 * Every row on the right is a consequence of one decision: normalize FIRST, to a
 * format this desk chose. `media.ts` carries the argument for each.
 *
 * ## The plan is made in the BODY, and that is legal
 *
 * `planSegments` runs in the BODY rather than in a step, which looks like a rule
 * violation and is not: it is a pure function of `ingested.silences` and
 * `ingested.durationMs`, both of which came out of a journaled step result. So a
 * replay re-derives the identical list in the identical order, which is exactly
 * what `mapConcurrent` needs — every call shares the name `transcribeSegment`, so
 * a journal entry is matched by the ORDER its call was issued in.
 *
 * Putting it in a step would journal the same list twice (once as part of the
 * ingest result, once as the plan) and buy nothing.
 */

// ERASED at build time, so the body can name the schema's own output type without
// a runtime cycle back through `agent.ts` — the same mechanism `client.tsx` uses
// for `WorkflowOutputOf`.
import type { WorkflowContext, WorkflowInputOf } from "@alexkroman1/aai";
import { encodeWav, mapConcurrent, stepReadUpload, stepReport } from "@alexkroman1/aai/step";
import { countWords, formatDuration } from "@alexkroman1/aai/utils";
import type { audit } from "../agent.ts";
import { ingestRecording } from "./ingest.ts";
import {
  ANALYSIS_FORMAT,
  durationSeconds,
  planSegments,
  type Segment,
  speechFraction,
} from "./media.ts";
import { narrate, summarize } from "./summarize.ts";
import { transcribeSpan } from "./sync-api.ts";

/**
 * How many segments to keep in flight.
 *
 * A CONSTANT here, where `transcription-workflow` derives one per recording — and
 * the difference is the payoff of normalizing. That template cuts whatever format
 * it was handed, so the byte cost of a segment is a property of the file: the same
 * 32 segments are 94 MB of 16 kHz mono or 1.28 GB of a format at the endpoint's
 * ceiling, and only one of those is safe to have in flight. It has to divide a
 * measured byte budget to find a width.
 *
 * Here the format is {@link ANALYSIS_FORMAT} for every recording, so a segment is
 * at most 3.5 MB and 32 of them are 113 MB — comfortably inside the ~640 MB that
 * template measured as the point where the endpoint starts returning `503`s. So
 * the byte bound never binds and what is left is the endpoint's own knee, which it
 * measured at 32. Its `BYTES_IN_FLIGHT` and `MAX_SEGMENT_CONCURRENCY` docs carry
 * both measurements; this is the one number that survives them. *
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
export const SEGMENT_CONCURRENCY = 32;

/** What one segment's request came back with — the STEP's result, journaled. */
export type SegmentText = {
  index: number;
  text: string;
};

/** What a finished run reports. Small and JSON-shaped, like every step result. */
export type CallAudit = {
  /** The uploaded file's own name. */
  source: string;
  /** What ffprobe made of it before the conversion — `aac`, `mp3`, `pcm_s16le`. */
  codec: string;
  /** Length of the audio. */
  durationMs: number;
  /** How long the RUN took, wall clock. */
  elapsedMs: number;
  /** How many requests the transcript was assembled from. */
  segments: number;
  /**
   * Segments whose end landed in speech because no pause was in range.
   *
   * `0` on an ordinary recording. Surfaced because it is the one thing that can
   * make this desk's transcript as seam-damaged as a blind cut's, and a reader
   * looking at a mangled word deserves to know which case they are in.
   */
  blindCuts: number;
  /** Share of the recording that is speech rather than pause, 0-100. */
  speechPercent: number;
  /** Integrated loudness BEFORE levelling, LUFS — what the recording arrived at. */
  loudnessBefore: number;
  words: number;
  transcript: string;
  /** One line naming what the call was about. */
  headline: string;
  /** What a reader should worry about. */
  risks: string[];
  /** What somebody has to do next. */
  actions: string[];
  /** The summary, written to be heard. */
  spoken: string;
  /**
   * Upload id of the spoken summary — an MP3, in this app's own store.
   *
   * An ID rather than the bytes, and that is the rule rather than a preference: a
   * run's output is read back as JSON. `api.download(id)` is the browser half.
   */
  audio: string;
  /** How long the spoken summary lasts. */
  audioDurationMs: number;
  /** Size of the MP3, which is the number that makes the mastering pass worth it. */
  audioBytes: number;
};

/**
 * Audit a call recording: level it, transcribe it, summarize it, read it back.
 *
 * The input is what `POST /workflows/runs` carries — see `agent.ts` for the schema
 * it is validated against before a run exists.
 */
export async function auditFlow(
  input: WorkflowInputOf<typeof audit>,
  ctx: WorkflowContext,
): Promise<CallAudit> {
  // Both at once: neither needs the other, and issued together they are one round
  // trip instead of two before any audio moves. The ORDER is still a pure function
  // of this expression — the two calls go out synchronously, left to right — which
  // is what a replay reproduces.
  //
  // `ctx.now()` rather than a step of its own: the engine journals the read under
  // its own key, so it is the moment the run really reached this line however
  // many times the line is walked. This was a `ctx.step("clockStart", now)` over
  // an exported one-line clock read, which is what everybody writes until the
  // affordance exists.
  // `maxAttempts: 6` was `ingestRecording.maxRetries = 5` — five retries AFTER
  // the first, so six in all. More than the default 3, and not because a
  // conversion is flaky: a corrupt file fails identically forever, and
  // `throwFfmpegStepError` is what stops the engine retrying that. It is the two
  // I/O halves that are worth another attempt — the step reads a whole recording
  // out of the store and writes a whole one back, and either can lose a
  // connection on a file this size.
  const [startedAt, ingested] = await Promise.all([
    ctx.now(),
    ctx.step("ingestRecording", () => ingestRecording(input.recording), { maxAttempts: 6 }),
  ]);

  // Pure, in the body, from journaled values. See the module doc. Planned against
  // the stored BYTE COUNT rather than the reported duration — `durationSeconds`
  // carries why those are not interchangeable.
  const segments = planSegments(ingested.silences, ingested.bytes);

  // One step per segment, bounded, in an order a replay reproduces exactly. A
  // failed segment fails the RUN deliberately: every sibling that finished is
  // already journaled, so a resume replays those for free and re-issues only what
  // is missing — where catching here to salvage a partial transcript would return
  // a recording with a silent hole in it and report success.
  // `mapConcurrent` hands out items from a monotonic cursor, so the Nth call
  // ISSUED is segment N whatever order they settle in — which is what makes
  // `transcribeSegment#N` stable across a replay. `maxAttempts: 6` was
  // `transcribeSegment.maxRetries = 5` — more than the default 3 because a rate
  // limit is the expected failure here, and a segment that 429s is not a segment
  // that is wrong.
  const parts = await mapConcurrent(segments, SEGMENT_CONCURRENCY, (segment) =>
    ctx.step("transcribeSegment", () => transcribeSegment(ingested.audio, segment), {
      maxAttempts: 6,
    }),
  );

  const transcript = joinSegments(segments, parts);
  const summary = await ctx.step("summarize", () =>
    summarize(transcript, ingested.source, ingested.durationMs),
  );
  const spoken = await ctx.step("narrate", () => narrate(summary.spoken, input.voice));
  const finishedAt = await ctx.now();

  // Whatever this returns is what a caller reads as `output` on a completed run —
  // so it is what the page renders, typed through `WorkflowOutputOf`. Assembled in
  // the body rather than in a step because every field is already journaled: a
  // step here would re-record values it was handed.
  return {
    source: ingested.source,
    codec: ingested.codec,
    durationMs: ingested.durationMs,
    elapsedMs: finishedAt - startedAt,
    segments: segments.length,
    blindCuts: segments.filter((segment) => segment.cutInSpeech).length,
    speechPercent: Math.round(
      speechFraction(ingested.silences, durationSeconds(ingested.bytes)) * 100,
    ),
    loudnessBefore: ingested.loudness.inputLufs,
    words: countWords(transcript),
    transcript,
    headline: summary.headline,
    risks: summary.risks,
    actions: summary.actions,
    spoken: summary.spoken,
    audio: spoken.audio,
    audioDurationMs: spoken.durationMs,
    audioBytes: spoken.bytes,
  };
}

/**
 * Transcribe one segment through the sync API.
 *
 * One step each, so a run that dies part-way resumes having replayed the finished
 * ones from the journal — no re-reading, no re-billing — and issues exactly the
 * calls that are missing.
 *
 * **`encodeWav` is what makes a byte range decodable.** The stored audio is
 * headerless PCM, and the endpoint decodes each request independently, so a slice
 * of it is meaningless bytes until a header says what they are. That header is the
 * SDK's (`@alexkroman1/aai/step`) rather than this template's: the equivalent
 * function in `transcription-workflow` is 25 lines of `DataView` writes with a
 * comment about which of the two declared lengths a decoder trusts, and there is
 * no reason for a second copy of it to exist.
 */
export async function transcribeSegment(audioId: string, segment: Segment): Promise<SegmentText> {
  // One line per segment, which is what makes the fan-out legible to a page: the
  // status is `running` for the whole thing, so without this a sixty-segment
  // recording and a one-segment recording look identical while they run.
  //
  // ORDER is not guaranteed here and does not need to be — the calls go out
  // together, so their lines interleave by completion, and `segment.index` is what
  // puts the TRANSCRIPT back in order.
  await stepReport(
    `Transcribing ${formatDuration(segment.startMs)}–${formatDuration(segment.endMs)}.`,
  );

  // `[start, end)`, the same half-open pair `planSegments` produced — the store
  // owns the conversion to HTTP's inclusive range, so there is no `- 1` here to get
  // wrong.
  const audio = await stepReadUpload(audioId, { start: segment.startByte, end: segment.endByte });
  const text = await transcribeSpan(
    encodeWav(audio.bytes, ANALYSIS_FORMAT),
    `segment-${segment.index}.wav`,
    `Segment ${segment.index} (${formatDuration(segment.startMs)})`,
  );

  return { index: segment.index, text };
}

/**
 * Join the segment transcripts into one.
 *
 * Ordered concatenation, and the absence of anything cleverer is the point:
 * segments do not overlap, so there is nothing to de-duplicate. The equivalent in
 * `transcription-workflow` is a seam matcher that looks back up to 40 words for a
 * repeated run and drops it — necessary there, because a blind cut forces a
 * two-second overlap to avoid splitting a word, and heuristic by nature.
 *
 * The one judgement left is the SEPARATOR, and the plan already knows the answer.
 * A cut placed in a pause is a turn or sentence boundary, so a paragraph break
 * reads correctly; a blind cut lands mid-sentence, so it gets a space. That is the
 * one place `cutInSpeech` changes an output rather than a report.
 */
export function joinSegments(segments: readonly Segment[], parts: readonly SegmentText[]): string {
  // `mapConcurrent` resolves in ITEM order however the calls settled, so this is
  // already ordered — sorted anyway, because a merge is where an ordering mistake
  // would be invisible rather than loud.
  const byIndex = new Map(parts.map((part) => [part.index, part.text]));
  let joined = "";
  for (const segment of segments) {
    const text = (byIndex.get(segment.index) ?? "").trim();
    if (text === "") continue;
    if (joined === "") {
      joined = text;
      continue;
    }
    // The separator belongs to the boundary BEFORE this segment, which is the
    // previous segment's end — so the flag read here is the earlier one's.
    const previous = segments[segment.index - 1];
    joined += previous?.cutInSpeech === true ? ` ${text}` : `\n\n${text}`;
  }
  return joined;
}
