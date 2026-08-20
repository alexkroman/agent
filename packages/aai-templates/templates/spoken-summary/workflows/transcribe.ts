// Copyright 2026 the AAI authors. MIT license.
/**
 * The first leg: the uploaded recording becomes text.
 *
 * Three steps and a durable wait, over AssemblyAI's ASYNC transcription API:
 *
 * ```text
 *   uploadToProvider   one step   →  the file, streamed, and the URL it answered
 *   createJob          one step   →  the transcript id
 *   pollTranscript     one step + a durable sleep, until the text comes back
 * ```
 *
 * **Every one of them is four lines, because the SDK owns the endpoint.**
 * `stepTranscribeUpload` / `stepTranscribeSubmit` / `stepTranscribePoll` on
 * `@alexkroman1/aai/utils` carry the URL, the raw-key auth, the windowed
 * streaming upload, the PLURAL `speech_models` field and the failure
 * classification — all of which this file used to spell out, and all of which
 * `transcription-workflow` used to spell out again, differently worded and
 * identical in behaviour. What is left here is what is genuinely this app's:
 * which steps to cut the job into, how long to wait, and what to report.
 *
 * ## The steps are still OURS, and they have to be
 *
 * The SDK cannot ship a `"use step"`: the Workflow DevKit's builder transforms
 * exactly the files under this `workflows/` directory, so a directive inside a
 * dependency would be transformed by nothing and would run inline with no
 * journal and no retry, silently. The SDK owns what happens INSIDE a step; the
 * boundaries — which is to say, what gets journaled and what a retry repeats —
 * are the app's.
 *
 * **The async API rather than the sync one, and the choice is about the FORM.**
 * The sync endpoint (`stepTranscribeSync`) answers inside the request and pays
 * for it with a hard 120-second, 40 MB cap, so a longer recording has to be cut
 * into segments and fanned out — which is a whole subject, and it has a
 * template (`transcription-workflow`, which shows that cut three ways and
 * measures them). This app's subject is the ROUND TRIP, so the transcription is
 * the one leg that should be as boring as possible.
 */

import { throwStepError } from "@alexkroman1/aai/step-errors";
import {
  report,
  stepTranscribePoll,
  stepTranscribeSubmit,
  stepTranscribeUpload,
  uploadInfo,
} from "@alexkroman1/aai/utils";

/** How long between polls of a submitted job. */
export const POLL_INTERVAL = "10s";

/**
 * Polls before the run gives up on a job.
 *
 * At {@link POLL_INTERVAL} this is an hour, well past what the async API takes
 * for any recording it accepts. Bounded rather than endless because a job that
 * never leaves `queued` is a run that would otherwise be replayed forever.
 */
export const MAX_POLLS = 360;

/** What the first leg hands the second. */
export type Transcript = {
  /** The FILENAME the uploader gave, not the opaque id — this reaches the page. */
  source: string;
  /** The provider's own measurement of the recording, in milliseconds. */
  durationMs: number;
  /** What was said. */
  text: string;
};

/**
 * Upload the recording to the provider and answer with the URL it gave.
 *
 * Its OWN step, and that is a measurement rather than a preference: folded into
 * the submit, a fault in the JSON body — a deprecated field, a bad model name —
 * makes the DevKit retry the whole step and re-upload the recording on every
 * attempt. A retry that repeats the expensive half to fix the cheap half is not
 * a retry. The `upload_url` is short-lived, so the risk being taken is that it
 * expires before the next step runs; that costs one fresh upload, once, instead
 * of five.
 *
 * `.catch(throwStepError)` is what turns the SDK's `TranscribeError` into the
 * DevKit's verdict — a missing key and a 400 stop, a 429 waits as long as the
 * service asked. Every step here ends the same way for the same reason.
 */
export async function uploadToProvider(uploadId: string): Promise<{ audioUrl: string }> {
  "use step";

  const stored = await uploadInfo(uploadId);
  await report(`Uploading ${stored.name || uploadId} (${mb(stored.size)}) for transcription.`);
  return await stepTranscribeUpload(uploadId).catch(throwStepError);
}

/** Retries beyond the default 3: an upload is the one call here worth another attempt. */
uploadToProvider.maxRetries = 5;

/** Create the transcription job, and answer with the id that outlives this run. */
export async function createJob(audioUrl: string): Promise<{ id: string }> {
  "use step";

  const job = await stepTranscribeSubmit(audioUrl).catch(throwStepError);
  await report(`Transcribing — job ${job.id}.`);
  return job;
}

/**
 * Ask once whether the job has finished, and read it when it has.
 *
 * One request answers both, which is the SDK's doing and worth knowing: this
 * used to poll for a status and then fetch the identical URL a second time for
 * the text. The body still branches on `done` rather than on a status string —
 * a provider's vocabulary must not be interpreted in a body, where a new status
 * would read as "not finished yet" forever.
 */
export async function pollTranscript(
  uploadId: string,
  id: string,
): Promise<{ done: false } | { done: true; transcript: Transcript }> {
  "use step";

  const progress = await stepTranscribePoll(id).catch(throwStepError);
  if (!progress.done) return { done: false };

  const stored = await uploadInfo(uploadId);
  await report(`Transcribed ${countWords(progress.transcript.text)} words.`);
  return {
    done: true,
    transcript: {
      source: stored.name || uploadId,
      durationMs: progress.transcript.durationMs,
      text: progress.transcript.text,
    },
  };
}

/** Words in a transcript, for the counts a page shows. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** A size a person can read, because the number that matters is the scale. */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
