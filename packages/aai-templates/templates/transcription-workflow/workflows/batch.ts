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
 * So this flow is four steps and no arithmetic:
 *
 * ```text
 *   uploadToProvider   one step   →  the file, streamed, and the URL it answered
 *   createJob          one step   →  the transcript id
 *   pollTranscript     one step + a durable sleep, until it is done
 *   readTranscript     one step   →  the text
 * ```
 *
 * **It is here to be compared against the other two, and it usually wins.** No
 * segment planning, no seam stitching, no concurrency to tune, no WAV-only
 * restriction — the provider accepts compressed audio, so an m4a straight off a
 * phone works where both sync flows refuse it. What you give up is control of the
 * inside: the latency is the provider's queue rather than your fan-out, and there is
 * nothing to report between "submitted" and "done" except the job's own status.
 *
 * ## The one thing that makes this a WORKFLOW rather than a request
 *
 * The wait. A job takes minutes, and nothing about an HTTP request survives minutes:
 * the poll has to outlive the process that started it, which is exactly what a
 * durable `sleep` is. `recap-workflow` ports Temporal's `polling` sample for this
 * shape and its module doc carries the argument; this is the same pattern with the
 * poll bounded by attempts rather than by a deadline.
 *
 * ## The upload STREAMS out of our own store
 *
 * `readUpload` hands back bytes, and a two-hour recording is not a value this process
 * can hold — so the body sent to `/v2/upload` is an async iterable of windows, which
 * `stepFetch` accepts precisely for this. Nothing is buffered beyond one window.
 *
 * That is also why the step that does it is the step the DevKit retries: a streaming
 * body is consumed once, so a retry has to re-read the upload from the start, which
 * it does. One window of READ-AHEAD keeps the store and the socket busy at the same
 * time; `windows` carries the argument.
 */

import { throwFatalStepError, toStepError } from "@alexkroman1/aai/step-errors";
import { readUpload, report, stepFetch, uploadInfo } from "@alexkroman1/aai/utils";
import { sleep } from "workflow";
import { apiKeyOrFatal } from "./sync-api.ts";
import { countWords, startClock, type Transcript } from "./transcribe.ts";

/** The async API's base. */
const API = "https://api.assemblyai.com";

/**
 * The models this desk asks for, best first.
 *
 * `speech_models`, PLURAL and an array. The singular `speech_model` is deprecated on
 * the async API and answers **400** for any current model name — which is how this
 * was found: the first live run of this flow failed on it, and the API said so in
 * exactly those words. Note the streaming API still uses the singular field, so the
 * two are not interchangeable and neither is "the" spelling.
 *
 * Omitting it entirely is also legal and routes to the default; naming it is what
 * pins the model so a default change does not silently move this template's output.
 */
const MODELS = ["universal-3-5-pro"];

/** How much of our stored upload one outbound window carries. */
const UPLOAD_WINDOW_BYTES = 4 * 1024 * 1024;

/** How long a single request may take. The upload is not one of these — see below. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * How long the upload leg may take.
 *
 * Its own budget because it is the one request whose duration is a function of the
 * FILE rather than of the service: a gigabyte at 8 MB/s is over two minutes, and a
 * deadline sized for a JSON round trip would cancel exactly the uploads this flow
 * exists to handle.
 */
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

/** How long between polls of a submitted job. */
const POLL_INTERVAL = "10s";

/**
 * Polls before the run gives up on a job.
 *
 * At {@link POLL_INTERVAL} this is an hour, which is well past what the async API
 * takes for any recording it accepts. Bounded rather than endless because a job that
 * never leaves `queued` is a run that would otherwise be replayed forever.
 */
const MAX_POLLS = 360;

/** Transcribe a recording through the async API. */
export async function transcribeBatchFlow(input: { recording: string }): Promise<Transcript> {
  "use workflow";

  // Both at once: the clock does not depend on the upload, and issuing them
  // together costs one round trip instead of two before a byte moves. Their issue
  // order is still decided by this line rather than by which lands first.
  const [startedAt, { audioUrl }] = await Promise.all([
    startClock(),
    uploadToProvider(input.recording),
  ]);
  const job = await createJob(audioUrl);

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    const status = await pollTranscript(job.id);
    if (status.done) return await readTranscript(input.recording, job.id, startedAt);
    await sleep(POLL_INTERVAL);
  }
  // A plain throw: this is the BODY, where the fatal/retryable distinction has
  // nothing to apply to — see `stream.ts`'s `abandon` for the same reasoning.
  throw new Error(
    `Transcript ${job.id} was still unfinished after ${MAX_POLLS} polls. It is not lost — ` +
      `read it directly with GET ${API}/v2/transcript/${job.id}.`,
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
 */
export async function uploadToProvider(uploadId: string): Promise<{ audioUrl: string }> {
  "use step";

  const apiKey = apiKeyOrFatal();
  const stored = await uploadInfo(uploadId);
  await report(`Uploading ${stored.name || uploadId} (${mb(stored.size)}) to the async API.`);

  const uploaded = await stepFetch(`${API}/v2/upload`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/octet-stream" },
    // An async iterable, not bytes: this file may be gigabytes, and nothing here holds
    // more than one window of it. See the module doc.
    body: windows(uploadId, stored.size),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!uploaded.ok) throw await failure(uploaded, "Upload");
  const { upload_url: audioUrl } = (await uploaded.json()) as { upload_url?: string };
  if (!audioUrl) {
    return throwFatalStepError(new Error("The async API accepted the upload but named no URL."));
  }
  return { audioUrl };
}

/** Retries beyond the default 3: an upload is the one call here worth another attempt. */
uploadToProvider.maxRetries = 5;

/** Create the transcription job, and answer with the id that outlives this run. */
export async function createJob(audioUrl: string): Promise<{ id: string }> {
  "use step";

  const created = await stepFetch(`${API}/v2/transcript`, {
    method: "POST",
    headers: { Authorization: apiKeyOrFatal(), "Content-Type": "application/json" },
    body: JSON.stringify({ audio_url: audioUrl, speech_models: MODELS }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!created.ok) throw await failure(created, "Submit");
  const { id } = (await created.json()) as { id?: string };
  if (!id) return throwFatalStepError(new Error("The async API created no transcript id."));

  await report(`Submitted transcript ${id}.`);
  return { id };
}

/**
 * Ask once whether the job has finished.
 *
 * `done` rather than the raw status, because the BODY branches on it and a body must
 * not be the place a provider's vocabulary is interpreted — a new status string would
 * otherwise be read as "not done yet" forever. A failed job is a terminal failure
 * here, not a `done: true` the caller has to re-check.
 */
export async function pollTranscript(id: string): Promise<{ done: boolean; status: string }> {
  "use step";

  const res = await stepFetch(`${API}/v2/transcript/${id}`, {
    headers: { Authorization: apiKeyOrFatal() },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw await failure(res, `Transcript ${id}`);
  const body = (await res.json()) as { status?: string; error?: string };
  const status = body.status ?? "unknown";
  if (status === "error") {
    // The provider has decided; no number of polls changes it.
    return throwFatalStepError(
      new Error(
        `The async API could not transcribe that recording: ${body.error ?? "no reason given"}`,
      ),
    );
  }
  await report(`Transcript ${id} is ${status}.`);
  return { done: status === "completed", status };
}

/** Read the finished transcript, and report it the way both sync flows do. */
export async function readTranscript(
  uploadId: string,
  id: string,
  startedAt: number,
): Promise<Transcript> {
  "use step";

  const res = await stepFetch(`${API}/v2/transcript/${id}`, {
    headers: { Authorization: apiKeyOrFatal() },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw await failure(res, `Transcript ${id}`);
  const body = (await res.json()) as { text?: string; audio_duration?: number };
  const transcript = (body.text ?? "").trim();
  const stored = await uploadInfo(uploadId);

  return {
    source: stored.name || uploadId,
    // ONE, and it is not a fudge: the async API transcribed the recording in one
    // piece, which is the difference this flow is here to show. A reader comparing
    // the three sees 7 segments, 7 segments, and 1.
    segments: 1,
    // The provider's own measurement, in seconds — the only one of the three flows
    // that does not have to derive this from byte offsets.
    durationMs: Math.round((body.audio_duration ?? 0) * 1000),
    // Wall clock, the same way both sync flows measure it — see `startClock`. For
    // this flow it is mostly the provider's queue, which is exactly the thing a
    // reader comparing the three wants to see.
    elapsedMs: Date.now() - startedAt,
    words: countWords(transcript),
    transcript,
  };
}

/**
 * The stored upload as a sequence of windows, with the next one already in flight.
 *
 * A generator rather than one `readUpload`, because the whole point is that the file
 * is never held: each window is read, sent, and dropped. `readUpload` clamps to what
 * is stored, so the loop ends on the real end of the file even if `size` moved.
 *
 * **One window of READ-AHEAD**, which is the whole concurrency available here: the
 * consumer is a socket and the producer is the app's own store, and read-then-send
 * makes them strictly alternate — the store idles while bytes go out, and the socket
 * idles while the next window is fetched. Starting the next read before yielding the
 * current window overlaps them, so a gigabyte upload pays the larger of the two
 * rather than their sum. Exactly one, not a queue: a deeper buffer holds more of a
 * file this generator exists to avoid holding, and there is nothing to gain past
 * keeping both ends busy.
 */
async function* windows(uploadId: string, size: number): AsyncGenerator<Uint8Array> {
  const read = (at: number): Promise<Uint8Array> =>
    readUpload(uploadId, { start: at, end: at + UPLOAD_WINDOW_BYTES }).then((slice) => slice.bytes);
  let at = 0;
  let next = at < size ? read(at) : undefined;
  while (next !== undefined) {
    const bytes = await next;
    if (bytes.length === 0) return;
    at += UPLOAD_WINDOW_BYTES;
    // Issued BEFORE the yield, so the store is fetching while the socket sends.
    next = at < size ? read(at) : undefined;
    yield bytes;
  }
}

/** A failed call, classified for the DevKit — see `sync-api.ts` for the three-way rule. */
async function failure(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return toStepError(
    res,
    `${what} failed: HTTP ${res.status}${body.error ? ` — ${body.error}` : ""}`,
  );
}

/** A size a person can read, because the number that matters is the scale. */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
