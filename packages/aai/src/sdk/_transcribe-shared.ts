// Copyright 2026 the AAI authors. MIT license.
/**
 * What AssemblyAI's two transcription endpoints share: the credential, the
 * deadline, and the failure.
 *
 * `step-transcribe.ts` (the async job API) and `step-transcribe-sync.ts` (the
 * one-request endpoint) are two genuinely different shapes — a job you poll
 * against a request you await — and almost nothing about them is common. What
 * IS common is everything a caller gets wrong: the key is passed RAW rather
 * than as a `Bearer`, a step with no deadline is a run that never finishes
 * rather than one that retries, and a failure has to carry enough for the
 * caller to decide whether asking again could help.
 *
 * Internal because it is the seam between those two modules, not a surface —
 * a step imports `stepTranscribe*`, never this.
 *
 * @module _transcribe-shared
 */

import { ASSEMBLYAI_STT_API_KEY_ENV } from "./providers/stt/assemblyai.ts";
import { requireStepEnv } from "./step-env.ts";
import { isTransientStatus, retryAfter } from "./step-retry.ts";

/**
 * Per-request deadline when a caller names none.
 *
 * Sized for a JSON round trip, which is what every call here is EXCEPT the
 * upload — that one is a function of the file rather than of the service and
 * carries its own budget. Nothing in the async API blocks: a submit answers
 * with an id and a poll answers with a status, both immediately.
 */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** Options every call in this family accepts. */
export type TranscribeRequestOptions = {
  /**
   * Env var holding the credential, replacing `ASSEMBLYAI_API_KEY`.
   *
   * Names a VARIABLE, not a key — the same contract every provider descriptor
   * keeps, so nothing here can end up in a journaled step argument.
   */
  apiKeyEnv?: string | undefined;
  /**
   * Deadline for this one request. Defaults to {@link TRANSCRIBE_TIMEOUT_MS}.
   */
  timeoutMs?: number | undefined;
  /**
   * Abort the request. Combined with the deadline rather than replacing it, so
   * a caller passing one still cannot hang forever.
   */
  signal?: AbortSignal | undefined;
};

/**
 * A failure from either endpoint, carrying what the caller needs to classify it.
 *
 * The SDK does not decide fatal-vs-retryable, for the same reason {@link stepSpeak}
 * does not: a helper that guessed would be guessing for every caller. What it can
 * do is carry the evidence, which is what `retryable` and `retryAfter` are —
 * read by `toStepError` on `@alexkroman1/aai/step-errors`, exactly as
 * `StepGenerateError`'s are. So a step body says `.catch(throwStepError)` and
 * gets the three-way call for free.
 *
 * @public
 */
export class TranscribeError extends Error {
  /** HTTP status the endpoint answered, when it answered one. */
  readonly status: number | undefined;
  /** Whether asking again could plausibly answer differently. */
  readonly retryable: boolean;
  /** How long the service asked us to wait, when it said. */
  readonly retryAfter: Date | undefined;

  constructor(
    message: string,
    init: { status?: number | undefined; retryable: boolean; retryAfter?: Date | undefined },
  ) {
    super(message);
    this.name = "TranscribeError";
    this.status = init.status;
    this.retryable = init.retryable;
    this.retryAfter = init.retryAfter;
  }
}

/**
 * The credential for a transcription call.
 *
 * Resolved per call rather than once per module: a step artifact is evaluated
 * long before any run reaches it, so a module-level read would capture the env
 * of the wrong moment — and `requireStepEnv` is what reports a missing key by
 * NAME instead of as a 401 from the far side.
 */
export function transcribeKey(opts: TranscribeRequestOptions): string {
  return requireStepEnv(opts.apiKeyEnv ?? ASSEMBLYAI_STT_API_KEY_ENV);
}

/**
 * The deadline for one request, as a signal.
 *
 * Combined rather than either/or: a caller's signal cancels sooner, and the
 * deadline still bounds a caller that passed none — or one whose own signal
 * never fires. Sources are held weakly, so there is no unlink bookkeeping.
 */
export function transcribeSignal(opts: TranscribeRequestOptions): AbortSignal {
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS);
  return opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
}

/**
 * A non-2xx answer, as an error carrying its own verdict.
 *
 * Both endpoints describe a failure in the body and they do not agree on the
 * shape — the async API says `{ error }`, the sync one says `{ message }` for a
 * request problem and `{ detail }` for auth and rate limits — so all three are
 * read and the first present one is reported. A body that is not JSON at all
 * (a proxy's HTML error page, which is what a gateway timeout usually is)
 * leaves the status to speak for itself rather than throwing a parse error over
 * the top of the real failure.
 */
export async function transcribeFailure(
  response: Response,
  what: string,
): Promise<TranscribeError> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    detail?: string;
  };
  const detail = body.error ?? body.message ?? body.detail;
  return new TranscribeError(
    `${what} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
    {
      status: response.status,
      retryable: isTransientStatus(response.status),
      retryAfter: retryAfter(response),
    },
  );
}

/**
 * A failure the endpoint reported with a 2xx, or one this module decided.
 *
 * Separate from {@link transcribeFailure} because there is no status to read a
 * verdict off: a job that came back `status: "error"`, a submit that created no
 * id, a recording with no speech in it. Every one of them answers the same way
 * on a retry, so they are NOT retryable — which is the whole value of saying so
 * here rather than letting the DevKit's default retry a decision the provider
 * has already made.
 */
export function transcribeRefusal(message: string): TranscribeError {
  return new TranscribeError(message, { retryable: false });
}
