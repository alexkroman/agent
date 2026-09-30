// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepPlaceCall()` / `stepCallStatus()` — the OUTBOUND half of telephony.
 *
 * The SDK has always ANSWERED calls: `WS /phone?carrier=twilio|telnyx` runs a
 * carrier's media stream as an ordinary session, and `sessionContext` receives
 * `call: { carrier, callId, parameters }` from the stream's `<Parameter>`s (see
 * `session-call.ts`). What it did not do was DIAL, so an app that places calls
 * (a household assistant calling a restaurant on someone's behalf) wrote its own
 * Twilio client — the form post, the TwiML, the XML escaping, the refusal codes
 * — and got the parts that are easy to get wrong wrong in private. These are
 * those parts, once.
 *
 * ## The loop, end to end
 *
 * 1. A step calls {@link stepPlaceCall} with the number, the caller id, the
 *    public base URL of the agent that should ANSWER (this one, or a separate
 *    calling agent), and the `parameters` that say which of the app's calls it
 *    is. Twilio is asked to dial with TwiML that, once the call is answered,
 *    connects its audio to `<agentUrl>/phone?carrier=twilio` and passes each
 *    parameter as a `<Parameter>`.
 * 2. The answering agent's `sessionContext` reads them as `call.parameters` —
 *    and should `refuse` a session whose parameters it did not issue, because
 *    the stream URL is not secret (see `SessionCall`).
 * 3. The step polls {@link stepCallStatus} (between `ctx.sleep`s) until the
 *    status is one of the five that are over, and the body reports how it went.
 *
 * ## What it refuses, and how
 *
 * Every failure is a {@link PlaceCallError} carrying `retryable` — `true` only
 * for a `429`, a `5xx`, or a request that never got an answer — so
 * `throwStepError` (`@alexkroman1/aai/step-errors`) classifies it with no help,
 * and a body that would rather SAY a refusal than retry it branches on the flag.
 * The Twilio codes a person can act on (bad credentials, an undiallable number,
 * a caller id not on the account, a trial account calling an unverified number,
 * geographic permissions) get a sentence saying what to fix; any other refusal
 * keeps Twilio's own message.
 *
 * **The auth token never appears in an error.** Twilio's answers are the far
 * side's text, and a run's error is stored, logged and shown; everything that
 * reaches a message goes through the channels' credential redaction first
 * (`redactCredentials`, `channels/shared/outbox.ts`), with the token, the SID
 * and the Basic credential listed.
 *
 * ## A retried dial can ring twice
 *
 * Twilio's Calls API takes no idempotency key, so a request whose ANSWER was
 * lost (the connection dropped after Twilio accepted it) is indistinguishable
 * from one that never arrived, and the retry dials again. That is the reason a
 * transport failure is still retryable rather than fatal — a call that was never
 * placed is the commoner case — and the reason to give the dialling step a small
 * `maxAttempts` and to journal the returned `callId` in its own step.
 *
 * ## Twilio only, for now
 *
 * Telnyx answers on `WS /phone` today, but placing a Telnyx call takes a Call
 * Control application id beyond the key, and its call record has no ringing /
 * busy / no-answer status to normalize — only "alive". So `carrier` accepts
 * `"twilio"` alone and a JavaScript caller passing anything else gets a
 * non-retryable {@link PlaceCallError} saying so.
 *
 * @module
 */

import {
  callStatusRequest,
  dialRequest,
  normalizeCallStatus,
  twilioAdvice,
} from "./_twilio-calls.ts";
import { redactCredentials } from "./channels/shared/outbox.ts";
import { isRecord } from "./is-record.ts";
import { stepEnv } from "./step-env.ts";
import { stepFetch } from "./step-fetch.ts";
import { retryAfter } from "./step-retry.ts";
import { errorMessage } from "./utils.ts";

/** The step env key {@link stepPlaceCall} reads the Twilio account SID from. */
export const TWILIO_ACCOUNT_SID_ENV = "TWILIO_ACCOUNT_SID";
/** The step env key {@link stepPlaceCall} reads the Twilio auth token from. */
export const TWILIO_AUTH_TOKEN_ENV = "TWILIO_AUTH_TOKEN";

/**
 * Default {@link PlaceCallOptions.timeLimitS}: Twilio hangs up after ten
 * minutes whatever the agent is doing, so a stuck conversation cannot run up
 * hours of minutes (Twilio's own default is four hours).
 */
export const DEFAULT_CALL_TIME_LIMIT_S: number = 600;
/**
 * Default {@link PlaceCallOptions.ringTimeoutS}: thirty seconds of ringing, then
 * `no-answer` — about five rings, short of most voicemail pickups.
 */
export const DEFAULT_CALL_RING_TIMEOUT_S: number = 30;

/**
 * A Twilio account's credentials. Pass them to name them yourself; omitted,
 * they are read from the step env as {@link TWILIO_ACCOUNT_SID_ENV} and
 * {@link TWILIO_AUTH_TOKEN_ENV}. Never put them in a run's INPUT, which is
 * journaled: read them inside the step.
 */
export type PlaceCallCredentials = {
  /** The account SID, `AC…`. */
  readonly accountSid: string;
  /** The auth token. A credential: it never appears in an error. */
  readonly authToken: string;
};

/** What {@link stepPlaceCall} takes. */
export type PlaceCallOptions = {
  /** The carrier that dials. `"twilio"` only, for now — see the module doc. */
  carrier: "twilio";
  /** The number to call, E.164 (`+15555550123`). Personal data. */
  to: string;
  /** The caller id: a number on the Twilio account, E.164. */
  from: string;
  /**
   * The PUBLIC base URL of the agent that answers — `https://…` or `wss://…`,
   * with any path prefix it is served under. The call's audio is streamed to
   * `<agentUrl>/phone?carrier=twilio`, so that agent must declare
   * `telephony` for Twilio.
   */
  agentUrl: string;
  /**
   * Custom parameters for the answering session, each a TwiML `<Parameter>`,
   * read there as `call.parameters`. At most 32, each name plus value under
   * 500 characters (Twilio's limit). Put an unguessable id here and check it
   * in `sessionContext`.
   */
  parameters?: Readonly<Record<string, string>>;
  /** Hard cap on the connected call, in seconds. Default {@link DEFAULT_CALL_TIME_LIMIT_S}. */
  timeLimitS?: number;
  /** How long it rings before `no-answer`, in seconds. Default {@link DEFAULT_CALL_RING_TIMEOUT_S}. */
  ringTimeoutS?: number;
  /** Explicit credentials; the step env otherwise. */
  credentials?: PlaceCallCredentials;
  signal?: AbortSignal;
};

/** What {@link stepPlaceCall} resolves: the carrier's id for the call (Twilio's `CA…` SID). */
export type PlacedCall = { callId: string };

/** What {@link stepCallStatus} takes. */
export type CallStatusOptions = {
  /** The carrier the call was placed through. */
  carrier: "twilio";
  /** {@link PlacedCall.callId}. */
  callId: string;
  /** Explicit credentials; the step env otherwise. */
  credentials?: PlaceCallCredentials;
  signal?: AbortSignal;
};

/**
 * Where a placed call is. The last five are OVER — nothing moves off them:
 * `completed` (answered and hung up), `busy`, `no-answer`, `failed` (never
 * connected: a bad number, a carrier refusal), `canceled` (hung up by the API
 * before it was answered). Twilio's `initiated` reads as `queued`.
 */
export type PlacedCallStatus =
  | "queued"
  | "ringing"
  | "in-progress"
  | "completed"
  | "busy"
  | "no-answer"
  | "failed"
  | "canceled";

/**
 * The {@link PlacedCallStatus} values nothing moves off — `completed`, `busy`,
 * `no-answer`, `failed`, `canceled`. What a loop following a call with
 * {@link stepCallStatus} stops on.
 *
 * Published because every body that dialled wrote its own copy of the list, and
 * a copy missing `canceled` polls a call the API already hung up until its
 * budget runs out.
 *
 * @public
 */
export const CALL_OVER_STATUSES: ReadonlySet<PlacedCallStatus> = new Set<PlacedCallStatus>([
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
]);

/**
 * Whether a call in `status` is over — one of {@link CALL_OVER_STATUSES}.
 *
 * Takes a `string` rather than a {@link PlacedCallStatus} so a loop can start
 * from a status it made up (`"queued"`) or read back from its own store without
 * a cast; anything unknown is not over.
 *
 * @public
 */
export function isCallOver(status: string): boolean {
  return (CALL_OVER_STATUSES as ReadonlySet<string>).has(status);
}

/**
 * The carrier refused, or never answered. `message` is a sentence a person can
 * act on and never quotes a credential; branch on `retryable`, which
 * `throwStepError` also reads.
 */
export class PlaceCallError extends Error {
  override readonly name = "PlaceCallError";
  /** The carrier asked. */
  readonly carrier: string;
  /** The HTTP status, or `undefined` when no request was answered (or none was made). */
  readonly status: number | undefined;
  /** The carrier's own error code — Twilio's `21219`, and so on — when it gave one. */
  readonly code: number | undefined;
  /** Whether another attempt could plausibly succeed: a `429`, a `5xx`, or no answer at all. */
  readonly retryable: boolean;
  /** When the carrier named a `Retry-After`, the moment it asked for. */
  readonly retryAfter: Date | undefined;

  constructor(
    message: string,
    init: {
      readonly carrier: string;
      readonly retryable: boolean;
      readonly status?: number | undefined;
      readonly code?: number | undefined;
      readonly retryAfter?: Date | undefined;
      readonly cause?: unknown;
    },
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.carrier = init.carrier;
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable;
    this.retryAfter = init.retryAfter;
  }
}

/** Longest one request to the carrier may take. */
const CARRIER_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Dial `to` from `from` and, once answered, stream the call to the agent at
 * `agentUrl`. Resolves the carrier's call id as soon as the carrier ACCEPTS the
 * request — the phone may not have rung yet; {@link stepCallStatus} follows it.
 *
 * @example Dial, then follow the call until it is over
 * ```ts
 * import type { WorkflowContext } from "@alexkroman1/aai";
 * import { isCallOver, requireStepEnv, stepCallStatus, stepPlaceCall } from "@alexkroman1/aai/step";
 *
 * export async function callFlow(input: { to: string; callRef: string }, ctx: WorkflowContext) {
 *   const { callId } = await ctx.step(
 *     "dial",
 *     () =>
 *       stepPlaceCall({
 *         carrier: "twilio",
 *         to: input.to,
 *         from: requireStepEnv("TWILIO_FROM_NUMBER"),
 *         agentUrl: requireStepEnv("CALLER_AGENT_URL"),
 *         parameters: { call: input.callRef },
 *       }),
 *     { maxAttempts: 2 },
 *   );
 *   let status = "queued";
 *   for (let i = 0; i < 60 && !isCallOver(status); i++) {
 *     await ctx.sleep("poll", new Date((await ctx.now()) + 10_000));
 *     status = await ctx.step("status", () => stepCallStatus({ carrier: "twilio", callId }));
 *   }
 *   return { callId, status };
 * }
 * ```
 *
 * @throws {PlaceCallError} On every failure — see the module doc.
 */
export async function stepPlaceCall(options: PlaceCallOptions): Promise<PlacedCall> {
  const credentials = resolveCredentials(options.carrier, options.credentials);
  const request = (() => {
    try {
      return dialRequest(credentials, {
        to: options.to,
        from: options.from,
        agentUrl: options.agentUrl,
        parameters: options.parameters ?? {},
        timeLimitS: options.timeLimitS ?? DEFAULT_CALL_TIME_LIMIT_S,
        ringTimeoutS: options.ringTimeoutS ?? DEFAULT_CALL_RING_TIMEOUT_S,
      });
    } catch (err: unknown) {
      // A malformed request is the caller's to fix, and asks the same way next time.
      throw new PlaceCallError(redact(credentials, errorMessage(err)), {
        carrier: "twilio",
        retryable: false,
        cause: err,
      });
    }
  })();
  const body = await send(credentials, request, options.signal);
  const sid = body.sid;
  if (typeof sid !== "string" || sid === "") {
    // Not retryable: Twilio said yes, so the phone may already be ringing, and a
    // retry would ring it a second time for an id the run could still not follow.
    throw new PlaceCallError("Twilio accepted the call but answered no call SID.", {
      carrier: "twilio",
      retryable: false,
    });
  }
  return { callId: sid };
}

/**
 * Where a placed call is now, as the carrier reports it, normalized to
 * {@link PlacedCallStatus}.
 *
 * @throws {PlaceCallError} On every failure, including a status this SDK does
 *   not know (non-retryable, naming it).
 */
export async function stepCallStatus(options: CallStatusOptions): Promise<PlacedCallStatus> {
  const credentials = resolveCredentials(options.carrier, options.credentials);
  const body = await send(
    credentials,
    callStatusRequest(credentials, options.callId),
    options.signal,
  );
  const status = normalizeCallStatus(body.status);
  if (status === undefined) {
    throw new PlaceCallError(
      `Twilio reported a call status this SDK does not know: ${redact(credentials, String(body.status))}`,
      { carrier: "twilio", retryable: false },
    );
  }
  return status;
}

/** The credentials to use: the explicit pair, else the step env, else a refusal naming both keys. */
function resolveCredentials(
  carrier: string,
  explicit: PlaceCallCredentials | undefined,
): PlaceCallCredentials {
  if (carrier !== "twilio") {
    throw new PlaceCallError(
      `Placing a call is Twilio only for now, not ${JSON.stringify(carrier)}: Telnyx can answer on ` +
        "WS /phone, but dialling through it is not built.",
      { carrier, retryable: false },
    );
  }
  const accountSid = (explicit?.accountSid ?? stepEnv(TWILIO_ACCOUNT_SID_ENV) ?? "").trim();
  const authToken = (explicit?.authToken ?? stepEnv(TWILIO_AUTH_TOKEN_ENV) ?? "").trim();
  if (accountSid === "" || authToken === "") {
    throw new PlaceCallError(
      `Twilio is not set up: set ${TWILIO_ACCOUNT_SID_ENV} and ${TWILIO_AUTH_TOKEN_ENV} in the ` +
        "agent's env, or pass `credentials`.",
      { carrier, retryable: false },
    );
  }
  return { accountSid, authToken };
}

/** Everything a message may not quote: the token, the SID, and the Basic credential made of both. */
function redact(credentials: PlaceCallCredentials, text: string): string {
  const basic = btoa(`${credentials.accountSid}:${credentials.authToken}`);
  return redactCredentials([credentials.authToken, basic, credentials.accountSid], text);
}

/** One request to Twilio, its JSON answer on success and a {@link PlaceCallError} otherwise. */
async function send(
  credentials: PlaceCallCredentials,
  request: { url: string; method: string; headers: Record<string, string>; body?: string },
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const deadline = AbortSignal.timeout(CARRIER_REQUEST_TIMEOUT_MS);
  const response = await stepFetch(request.url, {
    ...request,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  }).catch((err: unknown) => {
    throw new PlaceCallError(`Twilio did not answer: ${redact(credentials, errorMessage(err))}`, {
      carrier: "twilio",
      retryable: true,
      cause: err,
    });
  });
  // A body that is not a JSON object (an HTML error page from a proxy) reads as
  // empty: the status still decides the verdict, and the advice says `HTTP n`.
  const body: Record<string, unknown> = await response
    .json()
    .then((parsed: unknown) => (isRecord(parsed) ? parsed : {}))
    .catch(() => ({}));
  if (response.ok) return body;
  const code = typeof body.code === "number" ? body.code : undefined;
  const detail = typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
  // 429 and 5xx, and not `isTransientStatus`'s 408: Twilio answers a malformed
  // request fast, so a 408 from it is not the far side asking for patience.
  const retryable = response.status === 429 || response.status >= 500;
  throw new PlaceCallError(redact(credentials, twilioAdvice(code, detail, response.status)), {
    carrier: "twilio",
    status: response.status,
    code,
    retryable,
    retryAfter: retryAfter(response),
  });
}
