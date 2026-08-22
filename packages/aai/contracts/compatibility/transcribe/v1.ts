// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:transcribe` epoch 1.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are relative.
 *
 * Epoch 1 is the whole surface: the async job API's three calls and the sync
 * endpoint's one. What is frozen here is the SHAPE of the flow rather than any
 * one signature — that upload and submit are separate calls, that a poll
 * answers with the transcript rather than only a status, and that the failure
 * carries its own verdict — because that shape is what a caller's steps and
 * polling loop are built around. A change that merged two of these calls would
 * compile everywhere and silently move what a retry repeats.
 *
 * The `"use step"` directives are inert here — nothing compiles this through
 * the Workflow DevKit's builder — which is the point: what is frozen is the way
 * an author WRITES against the endpoints, and the only thing this must keep
 * doing is compile.
 */

import {
  stepTranscribePoll,
  stepTranscribeSubmit,
  stepTranscribeSync,
  stepTranscribeUpload,
  TRANSCRIBE_API,
  TRANSCRIBE_MODELS,
  TRANSCRIBE_SYNC_MODEL,
  TranscribeError,
  type TranscribeProgress,
  type TranscribeRequestOptions,
  type TranscribeSubmitOptions,
  type TranscribeSyncOptions,
  type Transcript,
} from "../../../sdk/step-barrel.ts";

/** Its own step, so a retry of the submit never repeats the file. */
export async function upload(uploadId: string): Promise<{ audioUrl: string }> {
  "use step";

  return await stepTranscribeUpload(uploadId);
}

/** The job, with this desk's own extras merged in verbatim. */
export async function submit(audioUrl: string): Promise<{ id: string }> {
  "use step";

  const opts: TranscribeSubmitOptions = {
    models: TRANSCRIBE_MODELS,
    params: { speaker_labels: true },
  };
  return await stepTranscribeSubmit(audioUrl, opts);
}

/** One poll, answering with the transcript the moment there is one. */
export async function poll(id: string): Promise<TranscribeProgress> {
  "use step";

  return await stepTranscribePoll(id);
}

/**
 * The body's loop: three steps and a durable wait.
 *
 * Written out because the loop is the thing this contract is really about —
 * the caller owns it, and it is only writable at all because `done` narrows the
 * progress union to one carrying the transcript.
 */
export async function transcribe(uploadId: string, sleep: (d: string) => Promise<void>) {
  "use workflow";

  const { audioUrl } = await upload(uploadId);
  const job = await submit(audioUrl);
  for (let n = 0; n < 360; n += 1) {
    const progress = await poll(job.id);
    if (progress.done) {
      const done: Transcript = progress.transcript;
      return done;
    }
    await sleep("10s");
  }
  throw new Error(`Still unfinished: GET ${TRANSCRIBE_API}/v2/transcript/${job.id}`);
}

/** The other endpoint: one request, no job, for audio that fits inside its cap. */
export async function transcribeClip(bytes: Uint8Array, index: number): Promise<string> {
  "use step";

  const opts: TranscribeSyncOptions = {
    model: TRANSCRIBE_SYNC_MODEL,
    filename: `segment-${index}.wav`,
    label: `segment ${index}`,
  };
  const { text } = await stepTranscribeSync(bytes, opts);
  return text;
}

/**
 * The failure carries its own verdict, which is what a caller classifies on.
 *
 * A provider refusal — a failed job, a recording with no speech — arrives with
 * `retryable: false` and no status, which is exactly the case a status-based
 * decision cannot reach.
 */
export function shouldRetry(err: unknown, opts: TranscribeRequestOptions): boolean {
  if (!(err instanceof TranscribeError)) return false;
  if (opts.signal?.aborted === true) return false;
  return err.retryable && err.retryAfter !== undefined;
}
