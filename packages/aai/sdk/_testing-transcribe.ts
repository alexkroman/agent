// Copyright 2026 the AAI authors. MIT license.
/**
 * `stubTranscribe` — AssemblyAI's transcription endpoints, answered in memory.
 *
 * The SDK owns four transcription calls — `stepTranscribeUpload`,
 * `stepTranscribeSubmit`, `stepTranscribePoll` (`@alexkroman1/aai/step`) and
 * `stepTranscribeSync` — and shipped no fake for any of them, so four template
 * specs re-typed the WIRE over `stubStepFetch`: `{ upload_url }`, then
 * `{ id }`, then `{ status: "completed", text, audio_duration }`. That is the
 * provider's vocabulary, restated in a spec, for a step whose whole purpose is
 * that the caller never has to know it — and one of them asserts the SDK's own
 * `Authorization` header and multipart boundary, which is this package's
 * contract to keep and `sdk/step-transcribe*.test.ts`'s to test.
 *
 * ## The failure half is the half worth having
 *
 * A fake that can only succeed is worse than none here, because the decision
 * these steps exist to support is RETRYABLE-vs-TERMINAL: a 429 drains on the
 * service's own `Retry-After`, a 400 answers the same way on the fourth attempt,
 * and a job the provider gave up on is finished no matter how long you poll. So
 * this can refuse — and it refuses by answering an HTTP STATUS, letting the
 * SDK's own `transcribeFailure` build the `TranscribeError` and set `retryable`.
 * Nothing here constructs that error, which is the point: a fake that minted its
 * own would be asserting the classification a spec is trying to test.
 *
 * ## It is a `stepFetch`, because that is what those steps call
 *
 * There is no synthesizer-style slot to fill for transcription (compare
 * `stubSpeech`): the four calls are HTTP, made through the published `stepFetch`
 * (`sdk/step-fetch.ts` carries why they may not use the global). So this
 * publishes one, routes the four transcription endpoints, and hands everything
 * else to `otherwise` — which is not a nicety: publishing REPLACES, so a flow
 * that also calls a model cannot install `stubStepFetch` beside this one, and
 * the spec that does it today routes both by URL in one handler.
 *
 * @module _testing-transcribe
 */

import {
  recordRequest,
  type StubStepAnswer,
  type StubStepRequest,
  toStepResponse,
} from "./_testing-step-fetch.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { publishStepFetch, type StepFetchInit } from "./step-fetch.ts";
import { TRANSCRIBE_API } from "./step-transcribe.ts";
import { TRANSCRIBE_SYNC_ENDPOINT } from "./step-transcribe-sync.ts";

/**
 * Which transcription call a request was.
 *
 * `"other"` is anything that is not one of the four — a model call, a feed
 * download — which reaches the `otherwise` handler rather than this fake.
 *
 * @public
 */
export type StubTranscribeLeg = "upload" | "submit" | "poll" | "sync" | "other";

/** One request {@link stubTranscribe} answered, with the leg it belonged to. */
export type StubTranscribeCall = StubStepRequest & {
  /** Which of the four calls this was, or `"other"`. */
  leg: StubTranscribeLeg;
};

/**
 * A refusal to stage, as an HTTP answer the SDK then classifies.
 *
 * Deliberately not a `TranscribeError`: the verdict a spec cares about
 * (`retryable`, `retryAfter`) is computed by `transcribeFailure` from the status
 * and the headers, so staging the STATUS exercises that classification and
 * staging the error would replace it. `429` and `5xx` are the transient pair,
 * `408` counts, and everything else is terminal — see `isTransientStatus` on
 * `@alexkroman1/aai/step`.
 *
 * @public
 */
export type StubTranscribeFailure = {
  /**
   * Which leg refuses. Defaults to ALL FOUR, which is what a spec asserting
   * "this flow reports a 429 as retryable" wants — it does not care which call
   * met the limit.
   */
  leg?: StubTranscribeLeg | readonly StubTranscribeLeg[] | undefined;
  /** The status to answer. Defaults to `500`. */
  status?: number | undefined;
  /**
   * What the body says went wrong.
   *
   * Sent as `{ error }`, which both endpoints' readers understand — the async
   * API's own spelling, and one of the three `transcribeFailure` accepts.
   */
  message?: string | undefined;
  /**
   * Seconds to put in `Retry-After`.
   *
   * The field a fan-out's behaviour turns on: four segments that hit a
   * per-minute limit together re-collect their 429s on a backoff nobody chose
   * unless the header is honoured, so a spec about batching needs to be able to
   * send one.
   */
  retryAfterSeconds?: number | undefined;
};

/** What {@link stubTranscribe} may be told. */
export type StubTranscribeOptions = {
  /**
   * The words a completed job or a sync request comes back with.
   *
   * A list is consumed one per COMPLETED answer and the last repeats, matching
   * `stubGateway`'s convention and for the same reason: a fan-out over segments
   * wants a different line per segment, and a stub that ran out mid-fan-out
   * would fail on the stub rather than on the code.
   *
   * An EMPTY string is meaningful rather than a lazy default: the async API's
   * poll refuses it (`"There is no speech in that recording"`, terminal), and
   * the sync endpoint accepts it — a silent segment in a fan-out is ordinary.
   * That asymmetry is real, and this is how a spec drives it.
   */
  text?: string | readonly string[] | undefined;
  /** The provider's own duration measurement, in seconds. Defaults to `60`. */
  durationSec?: number | undefined;
  /** What the upload leg answers with. Defaults to a fixed fake CDN URL. */
  audioUrl?: string | undefined;
  /**
   * Prefix for the job ids the submit leg mints. Defaults to
   * `"stub_transcript_"`, with a 1-based counter after it.
   *
   * Minted rather than random for the reason `stubUploads`'s ids are: a spec
   * asserting that a run journaled the job it later polled needs the id to be a
   * value it can write down.
   */
  jobIdPrefix?: string | undefined;
  /**
   * How many polls answer "still working" before the job completes. Defaults to
   * `0` — the first poll finds it done.
   *
   * Counted PER JOB ID, so a flow that submits two jobs sees each of them take
   * the same number of polls. Keep it small: a caller's polling loop usually
   * `sleep`s between polls, and outside a real run that wait is not one a spec
   * should be taking.
   */
  pendingPolls?: number | undefined;
  /**
   * Fail the JOB rather than the request: the poll answers `200` with
   * `status: "error"` and this reason.
   *
   * A different branch from {@link StubTranscribeOptions.failure} and the one
   * most likely to be got wrong in production code — the provider succeeded at
   * answering and the answer is "no". It is TERMINAL, and a flow that retried
   * it would poll a dead job until its budget ran out.
   */
  jobError?: string | undefined;
  /** Refuse at the HTTP level. See {@link StubTranscribeFailure}. */
  failure?: StubTranscribeFailure | undefined;
  /**
   * Answer everything that is not a transcription call.
   *
   * Publishing a `stepFetch` REPLACES, so a flow that transcribes AND calls a
   * model cannot have two fakes installed — this is the seam for the second
   * one. Returning `undefined` (or passing no handler) answers `404` with a body
   * naming the URL, which is a better failure than an empty `200` a step would
   * try to parse.
   */
  otherwise?:
    | ((
        request: StubStepRequest,
      ) => StubStepAnswer | undefined | Promise<StubStepAnswer | undefined>)
    | undefined;
};

/** What {@link stubTranscribe} returns. */
export type StubTranscribe = {
  /** Every request that reached the fake, in order, each tagged with its leg. */
  calls: StubTranscribeCall[];
  /**
   * Unpublish.
   *
   * Not optional — a `stepFetch` left published answers the next file's steps.
   * `installStubTranscribe` (`@alexkroman1/aai/testing/vitest`) is this with the
   * registration already done.
   */
  restore(): void;
};

/** The upload URL the fake hands back when the caller names none. */
const STUB_AUDIO_URL = "https://cdn.assemblyai.test/upload/stub";

/**
 * Answer AssemblyAI's transcription endpoints in memory, and record what was
 * sent.
 *
 * Covers all four calls — the async trio (`stepTranscribeUpload`,
 * `stepTranscribeSubmit`, `stepTranscribePoll`) and `stepTranscribeSync` — so a
 * workflow that uploads, submits, polls and reads is testable end to end without
 * naming `upload_url`, `audio_duration` or `status: "completed"` anywhere in the
 * spec.
 *
 * What it does NOT do is stand in for the upload STORE: `stepTranscribeUpload`
 * streams the recording out of the app's own store, so a spec still publishes
 * one with `stubUploads`. The two fakes fill different slots and compose.
 *
 * @example A whole async job, in one line of setup
 * ```ts no-check
 * // `no-check`: the workflow under test is in another file, which is the point.
 * import { stubTranscribe, stubUploads } from "@alexkroman1/aai/testing";
 *
 * const uploads = stubUploads({ upl_1: new Uint8Array(5000) });
 * const provider = stubTranscribe({ text: "we ship tuesday", durationSec: 42 });
 *
 * expect(await transcribeRecording("upl_1")).toBe("we ship tuesday");
 * // The file really streamed: `stubStepFetch` drains the body into bytes.
 * expect(provider.calls.find((call) => call.leg === "upload")?.body).toBeInstanceOf(Uint8Array);
 *
 * provider.restore();
 * uploads.restore();
 * ```
 *
 * @example A rate limit, classified by the SDK rather than by the fake
 * ```ts no-check
 * const provider = stubTranscribe({
 *   failure: { leg: "sync", status: 429, retryAfterSeconds: 30 },
 * });
 * // `toStepError` reads `retryable` and `retryAfter` off the real TranscribeError.
 * await expect(transcribeSegment("upl_1", segment)).rejects.toBeInstanceOf(RetryableError);
 * ```
 *
 * @public
 */
export function stubTranscribe(options: StubTranscribeOptions = {}): StubTranscribe {
  const calls: StubTranscribeCall[] = [];
  const texts =
    typeof options.text === "string" ? [options.text] : (options.text ?? ["hello there"]);
  const pollsByJob = new Map<string, number>();
  let completed = 0;
  let minted = 0;

  /** The next transcript, with the last entry repeating once the list runs out. */
  const nextText = (): string => {
    const at = Math.min(completed, texts.length - 1);
    completed += 1;
    return texts[at] ?? "";
  };

  /** A poll, keyed by the job id in the last path segment. */
  const answerPoll = (request: StubStepRequest): StubStepAnswer => {
    if (options.jobError !== undefined) {
      return { body: { status: "error", error: options.jobError } };
    }
    // Per job id, so a run that submits two jobs counts each one's pending
    // polls separately rather than sharing one countdown between them.
    const id = request.url.slice(request.url.lastIndexOf("/") + 1);
    const seen = pollsByJob.get(id) ?? 0;
    pollsByJob.set(id, seen + 1);
    if (seen < (options.pendingPolls ?? 0)) return { body: { status: "processing" } };
    return {
      body: { status: "completed", text: nextText(), audio_duration: options.durationSec ?? 60 },
    };
  };

  /** Anything that is not a transcription call — the caller's, or a 404. */
  const answerOther = async (request: StubStepRequest): Promise<StubStepAnswer> =>
    (await options.otherwise?.(request)) ?? {
      status: 404,
      body: { error: `stubTranscribe has no route for ${request.method} ${request.url}` },
    };

  const answerLeg = async (
    leg: StubTranscribeLeg,
    request: StubStepRequest,
  ): Promise<StubStepAnswer> => {
    if (leg === "other") return await answerOther(request);
    const refusal = failureFor(leg, options.failure);
    if (refusal) return refusal;
    if (leg === "upload") return { body: { upload_url: options.audioUrl ?? STUB_AUDIO_URL } };
    if (leg === "sync") return { body: { text: nextText() } };
    if (leg === "poll") return answerPoll(request);
    minted += 1;
    return { body: { id: `${options.jobIdPrefix ?? "stub_transcript_"}${minted}` } };
  };

  publishStepFetch(async (url: string, init: StepFetchInit = {}): Promise<Response> => {
    const request = await recordRequest(url, init);
    const leg = legOf(request);
    calls.push({ ...request, leg });
    return toStepResponse(await answerLeg(leg, request));
  });

  return { calls, restore: () => publishStepFetch(undefined) };
}

/**
 * Which call this request is.
 *
 * Matched against the SDK's own endpoint constants rather than against string
 * fragments, so a spec cannot pass because the fake and the step agree on a typo
 * — and a caller pointed at a different base falls through to `otherwise`, which
 * is honest: this fake knows AssemblyAI's endpoints and nothing else.
 */
function legOf(request: StubStepRequest): StubTranscribeLeg {
  const { url, method } = request;
  if (url.startsWith(TRANSCRIBE_SYNC_ENDPOINT)) return "sync";
  if (url === `${TRANSCRIBE_API}/v2/upload`) return "upload";
  if (url === `${TRANSCRIBE_API}/v2/transcript` && method === "POST") return "submit";
  if (url.startsWith(`${TRANSCRIBE_API}/v2/transcript/`)) return "poll";
  return "other";
}

/** The staged refusal for this leg, when one applies to it. */
function failureFor(
  leg: StubTranscribeLeg,
  failure: StubTranscribeFailure | undefined,
): StubStepAnswer | undefined {
  if (!failure) return undefined;
  if (!appliesTo(leg, failure.leg)) return undefined;
  const seconds = failure.retryAfterSeconds;
  return {
    status: failure.status ?? 500,
    body: { error: failure.message ?? `stubTranscribe refused the ${leg} call` },
    // `omitUndefined` rather than a conditional spread: same shape, and the
    // conditional one is what `guard-invariants` rule 2 counts.
    ...omitUndefined({
      headers: seconds === undefined ? undefined : { "Retry-After": String(seconds) },
    }),
  };
}

/** Whether a staged refusal covers this leg. An unnamed `leg` covers all four. */
function appliesTo(
  leg: StubTranscribeLeg,
  named: StubTranscribeLeg | readonly StubTranscribeLeg[] | undefined,
): boolean {
  if (named === undefined) return true;
  return typeof named === "string" ? named === leg : named.includes(leg);
}
