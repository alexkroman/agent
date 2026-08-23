// Copyright 2026 the AAI authors. MIT license.
/**
 * What both SYNC flows share, now that the endpoint itself is the SDK's.
 *
 * This module used to BE the endpoint: the URL, the model header, the raw-key auth,
 * the deadline, the multipart shape and the three-way failure classification. All of
 * that is `stepTranscribeSync` on `@alexkroman1/aai/step` — the same request, with
 * `transcription-workflow`'s own hard-won details (the unprefixed key, the
 * `X-AAI-Model` header, `stepFetch` rather than `fetch` so a fan-out's rate limit
 * arrives as a status rather than as a stream reset) carried into it.
 *
 * What is left is what belongs to the CALLER rather than to the endpoint, and it is
 * all measurement: both flows time each request, because per-part latency is the one
 * number that says which bound is actually binding.
 *
 * No directive, which is what lets it live under `workflows/` beside the bodies: the
 * WDK builder scans this directory and transforms only what carries one (`wav.ts` is
 * the same shape). It is called FROM steps, so it inherits their environment.
 */

import { stepTranscribeSyncClassified } from "@alexkroman1/aai/step-errors";

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
 * `stepTranscribeSyncClassified` — the SDK's own `stepTranscribeSync` plus
 * `throwStepError`, and nothing else — is the whole of what this adds to the SDK
 * call, and it is where the three-way call is made: a `FatalError` stops the DevKit retrying
 * something that will answer the same way, a bare `RetryableError` retries in ONE
 * SECOND (that class's own default), and a `RetryableError` carrying `retryAfter`
 * waits exactly as long as the far side asked. The last matters here because a whole
 * batch hits the rate limit together — a second later all of them ask again, where
 * on the server's number they drain.
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
  const { text } = await stepTranscribeSyncClassified(bytes, { filename, label });
  return text;
}
