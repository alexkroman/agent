// Copyright 2026 the AAI authors. MIT license.
/**
 * The first leg: the uploaded recording becomes text.
 *
 * Four steps and a durable wait, over AssemblyAI's ASYNC transcription API —
 * submit a job, poll it, read the transcript:
 *
 * ```text
 *   uploadToProvider   one step   →  the file, streamed, and the URL it answered
 *   createJob          one step   →  the transcript id
 *   pollTranscript     one step + a durable sleep, until it is done
 *   readTranscript     one step   →  the text
 * ```
 *
 * **The async API rather than the sync one, and the choice is about the FORM.**
 * The sync endpoint answers inside the request and pays for it with a hard
 * 120-second, 40 MB cap, so a longer recording has to be cut into segments and
 * fanned out — which is a whole subject, and it has a template
 * (`transcription-workflow`, which shows that cut three ways and measures
 * them). This app's subject is the ROUND TRIP, so the transcription is the one
 * leg that should be as boring as possible: no arithmetic, no seam stitching,
 * no WAV-only restriction. Reach for the other template when the fan-out is
 * what you are studying.
 *
 * ## The recording STREAMS out of our own store
 *
 * `readUpload` hands back bytes, and a two-hour recording is not a value this
 * process can hold — so the body sent to `/v2/upload` is an async iterable of
 * windows, which `stepFetch` accepts precisely for this. Nothing is buffered
 * beyond one window, and one window of READ-AHEAD keeps the store and the
 * socket busy at the same time.
 */

import { throwFatalStepError, toStepError } from "@alexkroman1/aai/step-errors";
import { readUpload, report, requireStepEnv, stepFetch, uploadInfo } from "@alexkroman1/aai/utils";

/** The async API's base. */
export const API = "https://api.assemblyai.com";

/**
 * The model this app asks for.
 *
 * `speech_models`, PLURAL and an array. The singular `speech_model` is
 * deprecated on the async API and answers **400** for any current model name.
 * Omitting it entirely is legal and routes to the default; naming it is what
 * stops a default change silently moving this template's output.
 */
const MODELS = ["universal-3-5-pro"];

/** How much of our stored upload one outbound window carries. */
const UPLOAD_WINDOW_BYTES = 4 * 1024 * 1024;

/** How long a single JSON request may take. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * How long the upload leg may take.
 *
 * Its own budget because it is the one request whose duration is a function of
 * the FILE rather than of the service, and a deadline sized for a JSON round
 * trip would cancel exactly the uploads this exists to handle.
 */
const UPLOAD_TIMEOUT_MS = 30 * 60_000;

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

/** The credential, or a FATAL failure: no retry finds a key that is not there. */
export function apiKeyOrFatal(): string {
  try {
    return requireStepEnv("ASSEMBLYAI_API_KEY");
  } catch (err: unknown) {
    return throwFatalStepError(err);
  }
}

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
 */
export async function uploadToProvider(uploadId: string): Promise<{ audioUrl: string }> {
  "use step";

  const apiKey = apiKeyOrFatal();
  const stored = await uploadInfo(uploadId);
  await report(`Uploading ${stored.name || uploadId} (${mb(stored.size)}) for transcription.`);

  const uploaded = await stepFetch(`${API}/v2/upload`, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/octet-stream" },
    // An async iterable, not bytes: this file may be gigabytes, and nothing
    // here holds more than one window of it.
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

  await report(`Transcribing — job ${id}.`);
  return { id };
}

/**
 * Ask once whether the job has finished.
 *
 * `done` rather than the raw status, because the BODY branches on it and a body
 * must not be where a provider's vocabulary is interpreted — a new status
 * string would otherwise read as "not done yet" forever. A failed job is a
 * terminal failure here, not a `done: true` the caller has to re-check.
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
      new Error(`That recording could not be transcribed: ${body.error ?? "no reason given"}`),
    );
  }
  return { done: status === "completed", status };
}

/** Read the finished transcript. */
export async function readTranscript(uploadId: string, id: string): Promise<Transcript> {
  "use step";

  const res = await stepFetch(`${API}/v2/transcript/${id}`, {
    headers: { Authorization: apiKeyOrFatal() },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw await failure(res, `Transcript ${id}`);
  const body = (await res.json()) as { text?: string; audio_duration?: number };
  const text = (body.text ?? "").trim();
  if (text.length === 0) {
    // FATAL rather than retryable, and it is the failure this template is most
    // likely to meet: a recording of silence transcribes successfully to
    // nothing, and everything downstream — the model, the voice — would
    // otherwise be asked to work with no words at all.
    return throwFatalStepError(
      new Error("There is no speech in that recording — nothing was transcribed."),
    );
  }
  const stored = await uploadInfo(uploadId);

  await report(`Transcribed ${countWords(text)} words.`);
  return {
    source: stored.name || uploadId,
    // The provider's own measurement, in seconds.
    durationMs: Math.round((body.audio_duration ?? 0) * 1000),
    text,
  };
}

/** Words in a transcript, for the counts a page shows. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * The stored upload as a sequence of windows, with the next one already in
 * flight.
 *
 * A generator rather than one `readUpload`, because the whole point is that the
 * file is never held: each window is read, sent, and dropped. `readUpload`
 * clamps to what is stored, so the loop ends on the real end of the file even
 * if `size` moved.
 *
 * **One window of READ-AHEAD**, which is the whole concurrency available here:
 * the consumer is a socket and the producer is the app's own store, and
 * read-then-send makes them strictly alternate. Issuing the next read before
 * yielding the current window overlaps them, so a large upload pays the larger
 * of the two rather than their sum.
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

/** A failed call, classified for the DevKit off its status. */
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
