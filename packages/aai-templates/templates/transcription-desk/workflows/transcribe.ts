// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the transcription desk: a FAN-OUT `"use workflow"` body.
 *
 * Read `research-desk/workflows/research.ts` first. It states the two rules
 * every directive body obeys — replayed from the top, so no live handles and no
 * undurable decisions; step arguments and return values are serialized, so pass
 * an id and not a payload — and both hold here unchanged. This file is about the
 * rule that only shows up once a body stops being a straight line:
 *
 * **the Workflow DevKit matches a journal entry to a step call by the ORDER the
 * call was issued in, not by anything the author names.**
 *
 * ## Where that comes from
 *
 * The workflow-mode transform rewrites every `"use step"` call into
 * `globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//file//name")(args)`, and
 * the runtime behind that symbol (`createUseStep`, `@workflow/core/dist/step.js`)
 * stamps each invocation with `step_${ctx.generateUlid()}` at the moment it is
 * issued. That generator is a monotonic ULID factory seeded from the run's own
 * `startedAt` and the VM's replay-stable `Math.random`, so it yields the same
 * sequence on the first execution and on every replay: the Nth step call in a
 * run gets the Nth id, always.
 *
 * The step's NAME is only cross-checked against the id the sequence handed out.
 * When the two disagree the run does not quietly re-run anything — it dies with
 * `ReplayDivergenceError`.
 *
 * So a step's identity is POSITIONAL, and the position is the issue order. Two
 * consequences decide the shape of everything below.
 *
 * ## 1. `Promise.all` over a `map` is safe
 *
 * `Promise.all(batch.map((c) => transcribeChunk(id, c)))` issues every call
 * SYNCHRONOUSLY, in array order, before it awaits anything. The issue order is
 * therefore the array order on the first run and on every replay, whatever order
 * the calls settle in. This is the fan-out the DevKit's own docs show.
 *
 * ## 2. A work-stealing pool is NOT safe, and that is the interesting part
 *
 * The obvious way to bound concurrency is a shared cursor — N workers each
 * looping "take the next item, await it" — and it is exactly wrong here. A
 * worker issues its next call only after its previous one SETTLES, so the issue
 * order follows the completion order: network latency on the first run, and the
 * event log on a replay. Those are not the same order, and where they differ the
 * ULID sequence hands `chunk 7`'s id to the call for `chunk 9`.
 *
 * Note what does not rescue it: there is no caller-supplied step key to pin the
 * association to a chunk's POSITION. That was available under this repo's
 * previous hand-rolled engine (`ctx.step("chunk-3", …)`) and is the one piece
 * that did not survive the move to the DevKit — the name is a cross-check, not
 * a key.
 *
 * Hence {@link CHUNK_CONCURRENCY} and the sequential batches below. Batching
 * costs the tail of each batch — a batch runs at the speed of its slowest member
 * and leaves workers idle at the boundary — and under this replay model it is
 * the only bounded fan-out that is deterministic, so the cost is the price of
 * correctness rather than a shortcut.
 */

import { FatalError } from "workflow";

/**
 * Seconds of audio per chunk.
 *
 * Stands in for the real constraint: a synchronous transcription API answers in
 * one request and caps how much audio one request may carry, so a long recording
 * is not one call but dozens.
 */
const CHUNK_SECONDS = 60;

/**
 * Chunks transcribed at once — see the module doc's second consequence.
 *
 * Bounded because the far side of a real call is a rate limit: a whole recording
 * issued at once collects 429s, and a rate-limited chunk fails its step. Four is
 * well inside any per-account limit and still turns forty round trips into ten.
 */
const CHUNK_CONCURRENCY = 4;

/** One slice of a recording, as `splitRecording` reports it. */
export type Chunk = {
  /** Position in the recording. Also this chunk's position in the transcript. */
  index: number;
  startMs: number;
  endMs: number;
};

/**
 * Transcribe a recording chunk by chunk and file the result.
 *
 * The step SET is not derivable from the input — how many chunks a recording
 * takes depends on how long it is, which is I/O and therefore a step. That is
 * fine, and it is the second thing this template exists to show: a fan-out's
 * WIDTH may come from a step's result, because that result is journaled. It may
 * not come from anything the body computes for itself, which is the same rule as
 * ever, applied one level up.
 */
export async function transcribeFlow(input: { recordingId: string; requestedBy: string }) {
  "use workflow";

  const chunks = await splitRecording(input.recordingId);

  const parts: string[] = [];
  for (let from = 0; from < chunks.length; from += CHUNK_CONCURRENCY) {
    // `slice` + `Promise.all`, never a shared cursor across the whole list —
    // see the module doc. Each batch issues its calls in array order and the
    // batches run in index order, so the issue order is a pure function of
    // `chunks` and survives replay.
    const batch = chunks.slice(from, from + CHUNK_CONCURRENCY);
    const texts = await Promise.all(
      batch.map((chunk) => transcribeChunk(input.recordingId, chunk)),
    );
    parts.push(...texts);
  }

  // A failed chunk fails the RUN, deliberately. Every sibling that finished is
  // already journaled, so the resume replays those for free and re-issues only
  // what is missing; catching here to salvage a partial transcript would ship a
  // recording with a silent hole in it and report success.

  // Chunk boundaries fall mid-sentence, so the seam is a space: each chunk
  // carries its own punctuation and inventing more would assert structure that
  // is not in the audio.
  const transcript = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");

  const filed = await file(input.requestedBy, input.recordingId, transcript);

  // Whatever this returns is what `ctx.workflows.get(runId)` reports as `output`
  // on a completed run — so it is what the desk reads back to the caller.
  return {
    recordingId: input.recordingId,
    chunks: chunks.length,
    words: transcript.split(/\s+/).filter(Boolean).length,
    transcript,
    filedAt: filed.filedAt,
  };
}

/**
 * Look the recording up and report its chunk boundaries.
 *
 * A step, because it reads something outside the run — and because its result is
 * what the fan-out's width is derived from, which only holds if that result is
 * journaled.
 *
 * Stands in for the real lookup, so the template runs with no credentials and no
 * stored audio. The SHAPE is the part to copy: a step returns small, serializable
 * data. Returning the audio itself would put a recording in the journal, which
 * replay re-reads on every resume.
 */
async function splitRecording(recordingId: string): Promise<Chunk[]> {
  "use step";

  const durationMs = fakeDurationMs(recordingId);
  if (durationMs === 0) {
    // `FatalError` skips the retries — an unknown id is not a transient fault,
    // and retrying it three times only delays the same answer. A plain `throw`
    // here would be the wrong call: see `transcribeChunk`.
    throw new FatalError(`No recording named "${recordingId}"`);
  }

  const chunkMs = CHUNK_SECONDS * 1000;
  return Array.from({ length: Math.ceil(durationMs / chunkMs) }, (_unused, index) => ({
    index,
    startMs: index * chunkMs,
    endMs: Math.min((index + 1) * chunkMs, durationMs),
  }));
}

/**
 * Transcribe one chunk.
 *
 * One step per chunk, so a run that dies on chunk 27 resumes and replays 1–26
 * from the journal — no re-reading, no re-transcribing, no re-billing — and
 * issues exactly one new call.
 *
 * A plain `throw` here (unlike `splitRecording`'s `FatalError`) is what a
 * transient fault wants: the DevKit retries a step three times by default, and
 * the raised ceiling below is because a rate limit is the expected failure on a
 * fan-out and it clears on its own.
 */
async function transcribeChunk(recordingId: string, chunk: Chunk): Promise<string> {
  "use step";

  // Stands in for the transcription call. A real desk would `fetch` a
  // synchronous transcription endpoint here — the whole Node runtime is
  // available in a step, unlike in the body above.
  //
  // Note what it could NOT do today: reach the agent's `ctx.env` for the API
  // key. A step is bundled and dispatched separately from the agent bundle and
  // is handed no tool context, and the guest keeps the agent's secrets in
  // memory rather than in `process.env`. That gap is why this is a stub and not
  // a `fetch`, and it is the same reason `research-desk`'s `gather` is one.
  return `[${recordingId} ${chunk.startMs / 1000}s-${chunk.endMs / 1000}s] transcribed text.`;
}

/** Retries beyond the default 3, because a rate limit is the expected failure. */
transcribeChunk.maxRetries = 5;

/** What one filing records — small and serializable, like every step result. */
export type Filed = {
  filedAt: string;
  /** What a real write would have keyed the row on. */
  key: string;
  characters: number;
};

/**
 * File the finished transcript.
 *
 * Separate from the chunk steps on purpose: a crash between the last chunk and
 * the filing replays every chunk for free and re-issues only the filing. One
 * step doing both would redo the expensive half whenever the cheap half failed.
 */
async function file(requestedBy: string, recordingId: string, transcript: string): Promise<Filed> {
  "use step";

  // A real desk would write to its database here. Returning the timestamp rather
  // than reading a clock in the BODY is the journaling rule again: a step's
  // result is stable across replays where a clock read in the body is not.
  return {
    filedAt: new Date().toISOString(),
    key: `${recordingId}:${requestedBy}`,
    characters: transcript.length,
  };
}

/**
 * A recording's length, faked from its id so the template needs no stored audio.
 *
 * Deterministic on purpose — a step may legitimately be non-deterministic, but a
 * FIXTURE that changed per call would make the chunk count differ between a run
 * and its own retry, which reads as a workflow bug rather than a fixture one.
 */
function fakeDurationMs(recordingId: string): number {
  if (recordingId === "unknown") return 0;
  // 1–10 chunks' worth, keyed off the id's length.
  return ((recordingId.length % 10) + 1) * CHUNK_SECONDS * 1000;
}
