// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the transcription desk: split a recording, transcribe
 * every piece, stitch the pieces back together.
 *
 * Read `research-desk/workflows/research.ts` first. It states the two rules
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
 *   is journaled and replayed on every resume, so the recording lives behind a
 *   URL and each step fetches exactly its own window with an HTTP `Range`
 *   request. Sixty steps therefore move the recording once between them, not
 *   sixty times.
 * - **The fan-out is bounded by `mapInBatches`, and the bound is not a detail.**
 *   The DevKit correlates a journal entry to a step call by the ORDER the call
 *   was issued in, so a work-stealing pool — which issues its next call only
 *   when a previous one settles — puts the calls in a different order on a
 *   replay than it did on the first execution. That primitive is sequential
 *   batches of `Promise.all` for exactly that reason; its module doc carries the
 *   argument.
 */

import { errorMessage, mapInBatches, requireStepEnv } from "@alexkroman1/aai/utils";
import { FatalError, getWritable } from "workflow";
import {
  parseWav,
  planSegments,
  type Segment,
  UnsupportedRecordingError,
  type WavFormat,
  wavWithHeader,
} from "./wav.ts";

/** The synchronous transcription endpoint. Global — it routes to the nearest region. */
const SYNC_ENDPOINT = "https://sync.assemblyai.com/transcribe";

/** Required on every sync request; the endpoint routes on it. */
const SYNC_MODEL = "universal-3-5-pro";

/** The key a step reads out of the agent env. Declared in `agent.ts`'s `requiredEnv`. */
const API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/**
 * Segments in flight at once.
 *
 * Bounded because the far side is a rate limit: a two-hour recording issued at
 * once collects 429s, and a rate-limited segment fails its step. Four is a
 * starting point, not a measurement — raise it against your own account's
 * concurrency and watch the retry count.
 */
const SEGMENT_CONCURRENCY = 4;

/**
 * Bytes probed for the WAV header.
 *
 * The canonical header is 44 bytes; a recorder that writes a `LIST` or `bext`
 * chunk in front of the samples pushes the `data` chunk further out, and 64 KB
 * covers every such file anyone has produced by accident.
 */
const HEADER_PROBE_BYTES = 64 * 1024;

/** The endpoint's own per-request deadline, plus room to upload. */
const SYNC_TIMEOUT_MS = 60_000;

/** Most words `stitchTranscript` will look back over to find a repeated seam. */
const MAX_SEAM_WORDS = 40;

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
export async function transcribeFlow(input: { recordingUrl: string; languageCode: string }) {
  "use workflow";

  const plan = await splitRecording(input.recordingUrl);

  // One step per segment, bounded, in an order a replay reproduces exactly.
  // A failed segment fails the RUN, deliberately: every sibling that finished is
  // already journaled, so the resume replays those for free and re-issues only
  // what is missing, where catching here to salvage a partial transcript would
  // return a recording with a silent hole in it and report success.
  const parts = await mapInBatches(plan.segments, SEGMENT_CONCURRENCY, (segment) =>
    transcribeSegment(input.recordingUrl, plan.format, segment, input.languageCode),
  );

  // Whatever this returns is what a caller reads as `output` on a completed run
  // — so it is what the page renders, typed through `WorkflowOutputOf`.
  return await mergeTranscript(input.recordingUrl, plan.durationMs, parts);
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
export async function splitRecording(recordingUrl: string): Promise<{
  format: WavFormat;
  segments: Segment[];
  durationMs: number;
}> {
  "use step";

  const head = await fetchRange(recordingUrl, 0, HEADER_PROBE_BYTES - 1);
  const format = fatalOnUnsupported(() => parseWav(head.bytes, head.totalBytes));
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
  recordingUrl: string,
  format: WavFormat,
  segment: Segment,
  languageCode: string,
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

  const apiKey = apiKeyOrFatal();
  const audio = await fetchRange(recordingUrl, segment.start, segment.end - 1);

  const form = new FormData();
  form.append(
    "audio",
    new Blob([wavWithHeader(format, audio.bytes)], { type: "audio/wav" }),
    `segment-${segment.index}.wav`,
  );
  form.append(
    "config",
    new Blob([JSON.stringify({ language_code: languageCode })], { type: "application/json" }),
  );

  const response = await fetch(SYNC_ENDPOINT, {
    method: "POST",
    // The raw key — this endpoint takes it unprefixed, and a `Bearer ` in front
    // of it is a 401 that reads like a wrong key.
    headers: { Authorization: apiKey, "X-AAI-Model": SYNC_MODEL },
    body: form,
    // `fetch` has no deadline of its own, and a hung upload inside a step is a
    // run that never finishes rather than one that retries.
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });
  if (!response.ok) throw await syncFailure(response, segment);

  const body = (await response.json()) as { text?: string };
  return { index: segment.index, text: (body.text ?? "").trim() };
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
  recordingUrl: string,
  durationMs: number,
  parts: readonly SegmentTranscript[],
): Promise<{
  source: string;
  segments: number;
  durationMs: number;
  words: number;
  transcript: string;
}> {
  "use step";

  await report(`Stitching ${parts.length} segment${parts.length === 1 ? "" : "s"} together.`);

  // `mapInBatches` resolves in ITEM order however the calls settled, so this is
  // already ordered — sorted anyway, because the merge is where an ordering
  // mistake would be invisible rather than loud.
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  const transcript = stitchTranscript(ordered.map((part) => part.text));

  return {
    source: recordingUrl,
    segments: parts.length,
    durationMs,
    words: countWords(transcript),
    transcript,
  };
}

// ---- Pure helpers -----------------------------------------------------------

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

/** Words in a string. */
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** `m:ss` for the progress log — a byte offset means nothing to a reader. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// ---- I/O helpers ------------------------------------------------------------

/**
 * Write one progress line to the run's own stream.
 *
 * The only way a run can say anything before it finishes: a snapshot carries a
 * status and, once terminal, an output, so without this a sixty-segment
 * recording reads as `running` for the whole fan-out. `client.tsx` reads it back
 * with `useWorkflowProgress`.
 *
 * Two properties worth copying. It is called from STEPS and never from the body,
 * the same rule as `ctx.db`: the body replays from the top on every resume, so a
 * line written there is re-emitted on each one. And it is BEST-EFFORT — a run
 * must not fail because its narration could not be written, which is also what
 * keeps the steps above callable from this template's own spec, where there is
 * no run and `getWritable()` throws by design.
 */
async function report(line: string): Promise<void> {
  try {
    const writer = getWritable<string>().getWriter();
    try {
      await writer.write(line);
    } finally {
      // Released rather than closed: later steps write to the same stream, and a
      // closed stream cannot be reopened.
      writer.releaseLock();
    }
  } catch {
    // No run in scope, or the stream is already gone. Neither is worth a failure.
  }
}

/**
 * Re-throw as terminal, so the DevKit stops retrying.
 *
 * A plain function rather than a `throw` inside each `catch`: `FatalError` takes
 * only a message — no `cause` — so constructing one directly in a catch block
 * loses the original error where the linter (rightly) expects it to be
 * preserved. Here the original is the ARGUMENT, and nothing is being swallowed.
 */
function fatal(err: unknown): never {
  throw new FatalError(errorMessage(err));
}

/** The API key, or a terminal failure — three more attempts find the same gap. */
function apiKeyOrFatal(): string {
  try {
    return requireStepEnv(API_KEY_ENV);
  } catch (err: unknown) {
    return fatal(err);
  }
}

/** Run a `wav.ts` helper, turning its "cannot cut this" into a terminal failure. */
function fatalOnUnsupported<T>(read: () => T): T {
  try {
    return read();
  } catch (err: unknown) {
    if (err instanceof UnsupportedRecordingError) return fatal(err);
    throw err;
  }
}

/**
 * Fetch one byte range of the recording.
 *
 * A server that HONOURS `Range` answers 206 and sends only the window, which is
 * the whole point: sixty segments then move the recording once between them.
 * One that ignores it answers 200 with the entire file, which is correct but
 * expensive — so the range is applied here as well, rather than trusting the
 * status. Both cases have to work, because "wherever your recording is hosted"
 * is not a server this template gets to choose.
 */
async function fetchRange(
  url: string,
  start: number,
  endInclusive: number,
): Promise<{ bytes: Uint8Array; totalBytes: number }> {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${endInclusive}` },
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });
  if (!response.ok) throw fetchFailure(response, url);

  const body = new Uint8Array(await response.arrayBuffer());
  if (response.status === 206) {
    return { bytes: body, totalBytes: rangeTotal(response) ?? start + body.length };
  }
  return { bytes: body.subarray(start, endInclusive + 1), totalBytes: body.length };
}

/** The file's size out of a `Content-Range: bytes 0-65535/12345678` header. */
function rangeTotal(response: Response): number | undefined {
  const total = Number(/\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1]);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/**
 * The failure a bad recording URL deserves.
 *
 * The split is the one every retrying caller has to make: a 404 or a 403 will
 * answer the same way on the fourth attempt, so it is terminal, while a 5xx or a
 * rate limit is exactly what retries are for.
 */
function fetchFailure(response: Response, url: string): Error {
  const message = `GET ${url} failed: HTTP ${response.status}`;
  return isTransient(response.status) ? new Error(message) : new FatalError(message);
}

/** The sync endpoint's failure, with whatever it said about it. */
async function syncFailure(response: Response, segment: Segment): Promise<Error> {
  // Two shapes, documented: `{ error_code, message }` for a request problem and
  // `{ detail }` for auth and rate limits.
  const body = (await response.json().catch(() => ({}))) as { message?: string; detail?: string };
  const message = `Segment ${segment.index} (${clock(segment.startMs)}) failed: HTTP ${response.status}${
    (body.message ?? body.detail) ? ` — ${body.message ?? body.detail}` : ""
  }`;
  return isTransient(response.status) ? new Error(message) : new FatalError(message);
}

/** Will another attempt plausibly answer differently? */
function isTransient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
