// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow body, and the fan-out it plans.
 *
 * ```text
 *   now                 one step   →  when the run began
 *   ingestRecording     one step   →  levelled PCM + every pause   (ingest.ts)
 *   planSegments        the BODY   →  where to cut                 (media.ts, pure)
 *   transcribeSegment   N steps    →  one sync API request each, bounded
 *   summarize           one step   →  headline, risks, actions      (summarize.ts)
 *   narrate             one step   →  an MP3 of the summary         (summarize.ts)
 *   now                 one step   →  when it finished
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
 * `planSegments` runs in the directive body rather than in a step, which looks
 * like a rule violation and is not: it is a pure function of `ingested.silences`
 * and `ingested.durationMs`, both of which came out of a journaled step result.
 * So a replay re-derives the identical list in the identical order, which is
 * exactly what `mapConcurrent` needs — the DevKit correlates a journal entry to a
 * step call by the ORDER the call was issued in.
 *
 * Putting it in a step would journal the same list twice (once as part of the
 * ingest result, once as the plan) and buy nothing.
 */

import { encodeWav, mapConcurrent, readUpload, report } from "@alexkroman1/aai/step";
import { ingestRecording } from "./ingest.ts";
import {
  ANALYSIS_FORMAT,
  clock,
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
 * both measurements; this is the one number that survives them.
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
export async function auditFlow(input: {
  recording: string;
  // `| undefined` explicitly, not merely optional: `exactOptionalPropertyTypes` is
  // on repo-wide, and what a zod `.optional()` infers is a property that may be
  // PRESENT and undefined.
  voice?: string | undefined;
}): Promise<CallAudit> {
  "use workflow";

  // Both at once: neither needs the other, and issued together they are one round
  // trip instead of two before any audio moves. The ORDER is still a pure function
  // of this expression — the two calls go out synchronously, left to right — which
  // is what a replay reproduces.
  const [startedAt, ingested] = await Promise.all([now(), ingestRecording(input.recording)]);

  // Pure, in the body, from journaled values. See the module doc. Planned against
  // the stored BYTE COUNT rather than the reported duration — `durationSeconds`
  // carries why those are not interchangeable.
  const segments = planSegments(ingested.silences, ingested.bytes);

  // One step per segment, bounded, in an order a replay reproduces exactly. A
  // failed segment fails the RUN deliberately: every sibling that finished is
  // already journaled, so a resume replays those for free and re-issues only what
  // is missing — where catching here to salvage a partial transcript would return
  // a recording with a silent hole in it and report success.
  const parts = await mapConcurrent(segments, SEGMENT_CONCURRENCY, (segment) =>
    transcribeSegment(ingested.audio, segment),
  );

  const transcript = joinSegments(segments, parts);
  const summary = await summarize(transcript, ingested.source, ingested.durationMs);
  const spoken = await narrate(summary.spoken, input.voice);
  const finishedAt = await now();

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
 * SDK's (`@alexkroman1/aai/utils`) rather than this template's: the equivalent
 * function in `transcription-workflow` is 25 lines of `DataView` writes with a
 * comment about which of the two declared lengths a decoder trusts, and there is
 * no reason for a second copy of it to exist.
 */
export async function transcribeSegment(audioId: string, segment: Segment): Promise<SegmentText> {
  "use step";

  // One line per segment, which is what makes the fan-out legible to a page: the
  // status is `running` for the whole thing, so without this a sixty-segment
  // recording and a one-segment recording look identical while they run.
  //
  // ORDER is not guaranteed here and does not need to be — the calls go out
  // together, so their lines interleave by completion, and `segment.index` is what
  // puts the TRANSCRIPT back in order.
  await report(`Transcribing ${clock(segment.startMs)}–${clock(segment.endMs)}.`);

  // `[start, end)`, the same half-open pair `planSegments` produced — the store
  // owns the conversion to HTTP's inclusive range, so there is no `- 1` here to get
  // wrong.
  const audio = await readUpload(audioId, { start: segment.startByte, end: segment.endByte });
  const text = await transcribeSpan(
    encodeWav(audio.bytes, ANALYSIS_FORMAT),
    `segment-${segment.index}.wav`,
    `Segment ${segment.index} (${clock(segment.startMs)})`,
  );

  return { index: segment.index, text };
}

/**
 * Retries beyond the default 3, because a rate limit is the expected failure and a
 * segment that 429s is not a segment that is wrong.
 */
transcribeSegment.maxRetries = 5;

/**
 * When it is now, as epoch ms.
 *
 * A STEP, and that is the whole reason it exists rather than a `Date.now()` in the
 * body: a body replays from the top on every resume, so a clock read there returns
 * a different value each time and every duration derived from it would be a
 * different duration. A step's result is journaled, so this is the moment the run
 * really reached this line however many times it is replayed.
 *
 * Called twice — once at each end — rather than a `startClock`/`elapsed` pair,
 * because the alternative is a step taking every field of the output so it can
 * subtract inside itself. Two journal entries and a subtraction in the body is the
 * smaller thing.
 */
export async function now(): Promise<number> {
  "use step";

  return Date.now();
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

/** Words in a transcript, for the counts a page shows. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}
