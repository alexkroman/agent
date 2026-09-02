// Copyright 2026 the AAI authors. MIT license.
/**
 * The third desk: hand the whole recording to AssemblyAI's ASYNC API and wait.
 *
 * The other two flows exist because of one provider limit: the SYNC endpoint answers
 * inside the request and pays for it with a hard 120-second, 40 MB cap, so a long
 * recording has to be cut up and fanned out — and this template's whole subject is
 * the two ways to arrange that. The async API has no such cap. You submit a job, it
 * answers with an id in milliseconds, and the transcript is ready minutes later.
 *
 * So this flow is three steps and no arithmetic:
 *
 * ```text
 *   uploadToProvider   one step   →  the file, streamed, and the URL it answered
 *   createJob          one step   →  the transcript id
 *   pollTranscript     one step + a durable sleep, until the text comes back
 * ```
 *
 * **It is here to be compared against the other two, and it usually wins.** No
 * segment planning, no seam stitching, no concurrency to tune, no WAV-only
 * restriction — the provider accepts compressed audio, so an m4a straight off a
 * phone works where both sync flows refuse it. What you give up is control of the
 * inside: the latency is the provider's queue rather than your fan-out, and there is
 * nothing to report between "submitted" and "done" except the job's own status.
 *
 * ## The endpoint is the SDK's; the STEPS are ours
 *
 * `stepTranscribeUpload` / `stepTranscribeSubmit` / `stepTranscribePoll` on
 * `@alexkroman1/aai/step` own the URL, the raw-key auth, the windowed streaming
 * upload, the PLURAL `speech_models` field and the failure classification. This file
 * used to spell all of that out, and so did `spoken-summary` — the same ~200 lines
 * twice, reworded, identical in behaviour, and drifting apart at the edges.
 *
 * What stays here is what a dependency cannot decide: how many steps to cut the job
 * into, and therefore what is journaled and what a retry repeats. That is also
 * structural rather than stylistic — only the caller with a `ctx` can open a
 * step, so a step boundary shipped inside the SDK would be no boundary at all:
 * it would run inline, with no journal and no retry, silently.
 *
 * ## The one thing that makes this a WORKFLOW rather than a request
 *
 * The wait. A job takes minutes, and nothing about an HTTP request survives minutes:
 * the poll has to outlive the process that started it, which is exactly what a
 * durable `sleep` is. `recap-workflow` ports Temporal's `polling` sample for this
 * shape and its module doc carries the argument; this is the same pattern with the
 * poll bounded by attempts rather than by a deadline.
 *
 * ## Three steps, not four, and the fourth was a wasted round trip
 *
 * This used to poll `GET /v2/transcript/:id` for a status and then fetch the
 * identical URL a second time to read the text the poll already had in its hand.
 * {@link pollTranscript} answers with the transcript, so a finished job costs one
 * request rather than two and the value journaled by the last poll IS the result.
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { report, TRANSCRIBE_API, uploadInfo } from "@alexkroman1/aai/step";
import {
  stepTranscribePollClassified,
  stepTranscribeSubmitClassified,
  stepTranscribeUploadClassified,
} from "@alexkroman1/aai/step-errors";
import { countWords, formatBytes } from "@alexkroman1/aai/utils";
import type { Transcript } from "./transcribe.ts";

/** How long between polls of a submitted job. */
const POLL_INTERVAL_MS = 10_000;

/**
 * Polls before the run gives up on a job.
 *
 * At {@link POLL_INTERVAL_MS} this is an hour, well past what the async API takes for
 * any recording it accepts. Bounded rather than endless because a job that never
 * leaves `queued` is a run that would otherwise be replayed forever.
 */
const MAX_POLLS = 360;

/** Transcribe a recording through the async API. */
export async function transcribeBatchFlow(
  input: { recording: string },
  ctx: WorkflowCtx,
): Promise<Transcript> {
  // Both at once: the clock does not depend on the upload, and issuing them
  // together costs one round trip instead of two before a byte moves. Their issue
  // order is still decided by this line rather than by which lands first.
  // `maxAttempts: 6` was `uploadToProvider.maxRetries = 5` — five retries after
  // the first, so six in all. More than the default 3 because an upload is the
  // one call here worth another attempt: it moves the whole recording, and a lost
  // connection on a file this size is the expected failure.
  const [startedAt, { audioUrl }] = await Promise.all([
    ctx.now(),
    ctx.step("uploadToProvider", () => uploadToProvider(input.recording), { maxAttempts: 6 }),
  ]);
  const job = await ctx.step("createJob", () => createJob(audioUrl));

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    const progress = await ctx.step("pollTranscript", () =>
      pollTranscript(input.recording, job.id, startedAt),
    );
    if (progress.done) return progress.transcript;
    await ctx.sleep("poll", POLL_INTERVAL_MS);
  }
  // A plain throw: this is the BODY, where the fatal/retryable distinction has
  // nothing to apply to — see `stream.ts`'s `abandon` for the same reasoning.
  throw new Error(
    `Transcript ${job.id} was still unfinished after ${MAX_POLLS} polls. It is not lost — ` +
      `read it directly with GET ${TRANSCRIBE_API}/v2/transcript/${job.id}.`,
  );
}

/**
 * Upload the recording to the provider and answer with the URL it gave.
 *
 * Its own step, and that was a MEASUREMENT rather than a judgement. It began as one
 * step doing both calls, on the argument that an `upload_url` is useless alone and
 * expires — and the first live run showed what that costs: the create call failed on
 * a deprecated field, and the DevKit retried the whole step five times, re-uploading
 * 24 MB on every attempt for a fault in a JSON body. A retry that repeats the
 * expensive half to fix the cheap half is not a retry.
 *
 * So the URL is journaled after all. The risk that made that look wrong is real but
 * far smaller: if it expires before the next step runs, the run fails and a fresh one
 * re-uploads — which is what would have happened anyway, once, instead of five times.
 *
 * The `Classified` callers on `@alexkroman1/aai/step-errors` are the SDK's own
 * `stepTranscribe*` plus `throwStepError` and nothing else, which is what turns the
 * SDK's `TranscribeError` into the DevKit's verdict: a missing key and a 400 stop, a
 * 429 waits as long as the service asked. Every step here ends the same way for the
 * same reason.
 */
export async function uploadToProvider(uploadId: string): Promise<{ audioUrl: string }> {
  const stored = await uploadInfo(uploadId);
  await report(
    `Uploading ${stored.name || uploadId} (${formatBytes(stored.size)}) to the async API.`,
  );
  return await stepTranscribeUploadClassified(uploadId);
}

/** Create the transcription job, and answer with the id that outlives this run. */
export async function createJob(audioUrl: string): Promise<{ id: string }> {
  const job = await stepTranscribeSubmitClassified(audioUrl);
  await report(`Submitted — job ${job.id}.`);
  return job;
}

/**
 * Ask once whether the job has finished, and read it when it has.
 *
 * `done` rather than the raw status, because the BODY branches on it and a body must
 * not be where a provider's vocabulary is interpreted — a new status string would
 * otherwise read as "not done yet" forever. A failed job is a terminal failure
 * inside the SDK call, not a `done: true` the caller has to re-check.
 */
export async function pollTranscript(
  uploadId: string,
  id: string,
  startedAt: number,
): Promise<{ done: false } | { done: true; transcript: Transcript }> {
  const progress = await stepTranscribePollClassified(id);
  if (!progress.done) {
    await report(`Transcript ${id} is ${progress.status}.`);
    return { done: false };
  }

  const stored = await uploadInfo(uploadId);
  const transcript = progress.transcript.text;
  return {
    done: true,
    transcript: {
      source: stored.name || uploadId,
      // ONE, and it is not a fudge: the async API transcribed the recording in one
      // piece, which is the difference this flow is here to show. A reader comparing
      // the three sees 7 segments, 7 segments, and 1.
      segments: 1,
      // The provider's own measurement — the only one of the three flows that does
      // not have to derive this from byte offsets.
      durationMs: progress.transcript.durationMs,
      // Wall clock, the same way both sync flows measure it — the body's
      // `ctx.now()`, subtracted inside this step. For this flow it is mostly the
      // provider's queue, which is exactly the thing a reader wants to see.
      elapsedMs: Date.now() - startedAt,
      words: countWords(transcript),
      transcript,
    },
  };
}
