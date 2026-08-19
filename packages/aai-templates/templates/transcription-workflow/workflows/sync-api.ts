// Copyright 2026 the AAI authors. MIT license.
/**
 * One request to AssemblyAI's synchronous transcription endpoint.
 *
 * Extracted when the second flow arrived, and the split is the one that was
 * already there: both flows send exactly the same request and differ only in
 * where the bytes came from — a byte WINDOW of one stored recording
 * (`transcribe.ts`), or one PART of a group that is still being uploaded
 * (`stream.ts`). Everything that is a property of the endpoint rather than of the
 * caller lives here: the URL, the model header, the raw-key auth, the deadline,
 * the multipart shape, and the three-way failure classification.
 *
 * No directive, which is what lets it live under `workflows/` beside the bodies:
 * the WDK builder scans this directory and transforms only what carries one
 * (`wav.ts` is the same shape). It is called FROM steps, so it inherits their
 * environment — `requireStepEnv` works here for the same reason it works there.
 */

import { throwFatalStepError, toStepError } from "@alexkroman1/aai/step-errors";
import { multipartBody, requireStepEnv, stepFetch } from "@alexkroman1/aai/utils";

/** The synchronous transcription endpoint. Global — it routes to the nearest region. */
const SYNC_ENDPOINT = "https://sync.assemblyai.com/transcribe";

/** Required on every sync request; the endpoint routes on it. */
const SYNC_MODEL = "universal-3-5-pro";

/** The key a step reads out of the agent env. Declared in `agent.ts`'s `requiredEnv`. */
const API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/** The endpoint's own per-request deadline, plus room to upload. */
const SYNC_TIMEOUT_MS = 60_000;

/**
 * Time one transcription, so the progress log carries LATENCY.
 *
 * The reason this is worth reporting rather than left to a server log: the whole
 * shape of both flows is a bounded fan-out against an endpoint whose speed is
 * outside this code, and per-part latency is the one number that says which
 * bound is actually binding. Eight parts each taking 4s means the concurrency is
 * the limit; eight parts each taking 20s means the endpoint is. A log that only
 * says "transcribing" cannot tell those apart, and the choice between raising
 * `SEGMENT_CONCURRENCY` and leaving it alone is exactly that question.
 *
 * `Date.now()` is fine HERE and would not be in a body: a step's internals are
 * not replayed — only its RESULT is — which is what makes a step the place any
 * clock, random draw or outside read belongs.
 */
export async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await work();
  return { value, ms: Date.now() - started };
}

/** `4.2s`, or `840ms` under a second — a reader wants one significant change. */
export function elapsed(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Transcribe one complete WAV.
 *
 * `bytes` must be a whole file, header included — the endpoint decodes each
 * request independently, so a headerless tail is bytes it will refuse. Both
 * callers arrive at that differently: one re-attaches a header to a window it
 * read, the other is handed parts that already carry one.
 *
 * @param label - How this piece is named in a failure. The CALLER's vocabulary
 *   (a segment's timestamp, a part's index), because it is what a reader of the
 *   log has in front of them.
 */
export async function transcribeWav(
  bytes: Uint8Array,
  filename: string,
  label: string,
): Promise<string> {
  const apiKey = apiKeyOrFatal();
  const part = multipartBody({ name: "audio", filename, type: "audio/wav", bytes });

  // `stepFetch`, not `fetch`, and here it is load-bearing rather than tidy:
  // `fetch` speaks HTTP/2 wherever the far side offers it, which puts a whole
  // batch of segments on ONE connection — and a capacity limit then arrives as a
  // stream reset carrying no HTTP status for `toStepError` below to read. A
  // fan-out is exactly the shape that breaks on. `sdk/step-fetch.ts` holds the
  // measurements; a `StepTransportError` out of here is already retryable and
  // already names its cause.
  const response = await stepFetch(SYNC_ENDPOINT, {
    method: "POST",
    headers: {
      // The raw key — this endpoint takes it unprefixed, and a `Bearer ` in
      // front of it is a 401 that reads like a wrong key.
      Authorization: apiKey,
      "X-AAI-Model": SYNC_MODEL,
      ...part.headers,
    },
    body: part.body,
    // Nothing here has a deadline of its own, and a hung upload inside a step is
    // a run that never finishes rather than one that retries.
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });
  if (!response.ok) throw await syncFailure(response, label);

  const body = (await response.json()) as { text?: string };
  return (body.text ?? "").trim();
}

/**
 * The API key, or a terminal failure — three more attempts find the same gap.
 *
 * Exported because `batch.ts` calls the same provider on the same key and had
 * written this, and its own `API_KEY_ENV`, again. The key belongs to the
 * PROVIDER; only the endpoint and its failure shapes belong to this module.
 */
export function apiKeyOrFatal(): string {
  try {
    return requireStepEnv(API_KEY_ENV);
  } catch (err: unknown) {
    // `throwFatalStepError` rather than `throw new FatalError(…)`: that class
    // takes only a message — no `cause` — so constructing one inside a `catch`
    // loses the original where the linter (rightly) expects it preserved. Here
    // the original is the ARGUMENT, and nothing is swallowed.
    return throwFatalStepError(err);
  }
}

/**
 * The sync endpoint's failure, with whatever it said about it.
 *
 * `toStepError` makes the three-way call: a `FatalError` stops the DevKit
 * retrying something that will answer the same way, a bare `RetryableError`
 * retries in ONE SECOND (that class's own default), and a `RetryableError`
 * carrying `retryAfter` waits exactly as long as the far side asked. The last
 * matters here because a whole batch hits the rate limit together — a second
 * later all of them ask again, where on the server's number they drain.
 */
async function syncFailure(response: Response, label: string): Promise<Error> {
  // Two shapes, documented: `{ error_code, message }` for a request problem and
  // `{ detail }` for auth and rate limits.
  const body = (await response.json().catch(() => ({}))) as { message?: string; detail?: string };
  const detail = body.message ?? body.detail;
  return toStepError(
    response,
    `${label} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
  );
}
