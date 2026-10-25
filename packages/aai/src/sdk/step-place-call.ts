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
 * 1. A step calls {@link stepPlaceCall} with the number, the caller id, and
 *    the `parameters` that say which of the app's calls it is. Twilio is asked
 *    to dial and, once the call is answered, to fetch the webhook
 *    `<agentUrl>/phone?carrier=twilio` — this agent's public URL unless the
 *    step names another — with each parameter on its query
 *    (`phone-webhook.ts`). Whichever server answers that webhook (the
 *    platform's `/:slug/phone`, or a self-hosted server's own `/phone`) replies
 *    with TwiML that streams the audio to the agent's `WS /phone`, each
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

import { globalSlot } from "./_boundary.ts";
import {
  basicCredential,
  callStatusRequest,
  dialRequest,
  normalizeCallStatus,
  type TwilioRequest,
  twilioAdvice,
} from "./_twilio-calls.ts";
import {
  CALL_BRIEF_SECRET_ENV,
  type CallBrief,
  isCallBriefParameter,
  signCallBrief,
} from "./call-brief.ts";
import type { PlacedCallStatus } from "./call-status.ts";
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
 * @input
 */
export type PlaceCallCredentials = {
  /** The account SID, `AC…`. */
  readonly accountSid: string;
  /** The auth token. A credential: it never appears in an error. */
  readonly authToken: string;
};

/**
 * What {@link stepPlaceCall} takes.
 *
 * @input
 */
export type PlaceCallOptions = {
  /** The carrier that dials. `"twilio"` only, for now — see the module doc. */
  carrier: "twilio";
  /** The number to call, E.164 (`+15555550123`). Personal data. */
  to: string;
  /** The caller id: a number on the Twilio account, E.164. */
  from: string;
  /**
   * The PUBLIC base URL of the agent that answers — `https://…` or `wss://…`,
   * with any path prefix it is served under. Twilio fetches the webhook
   * `<agentUrl>/phone?carrier=twilio` once the call is answered, and that
   * agent must declare `telephony` for Twilio.
   *
   * Defaults to THIS agent's public URL, which the host publishes: the
   * deployed agent's own URL on the managed platform, the tunnel under
   * `aai dev --tunnel`, `PUBLIC_URL` for a self-hosted server. Pass it only to
   * have a DIFFERENT agent answer.
   */
  agentUrl?: string;
  /**
   * Custom parameters for the answering session, each a TwiML `<Parameter>`,
   * read there as `call.parameters`. At most 32, each name plus value under
   * 500 characters (Twilio's limit). Put an unguessable id here and check it
   * in `sessionContext`.
   */
  parameters?: Readonly<Record<string, string>>;
  /**
   * The call's BRIEF — the app's own call id and the task prompt — signed
   * with the secret in `briefSecretEnv` and carried on the call as the
   * parameters `call`, `sig` and `p0…pN` (`signCallBrief`), so the answering
   * session reads it back with `call.brief(secret)` and refuses a stream that
   * was not signed by this app. `parameters` may not use those names. The
   * prompt is at most `MAX_CALL_BRIEF_PROMPT_CHARS`.
   */
  brief?: CallBrief;
  /**
   * The step-env variable holding the secret `brief` is signed with. Default
   * `CALL_BRIEF_SECRET_ENV` (`"CALLS_API_KEY"`); the answering agent reads the
   * same variable from its env. Unset with a `brief` is a non-retryable refusal.
   */
  briefSecretEnv?: string;
  /** Hard cap on the connected call, in seconds. Default `DEFAULT_CALL_TIME_LIMIT_S`. */
  timeLimitS?: number;
  /** How long it rings before `no-answer`, in seconds. Default `DEFAULT_CALL_RING_TIMEOUT_S`. */
  ringTimeoutS?: number;
  /** Explicit credentials; the step env otherwise. */
  credentials?: PlaceCallCredentials;
  signal?: AbortSignal;
};

/**
 * What {@link stepPlaceCall} resolves: the carrier's id for the call (Twilio's `CA…` SID).
 *
 * @sealed
 */
export type PlacedCall = { callId: string };

/**
 * What {@link stepCallStatus} takes.
 *
 * @input
 */
export type CallStatusOptions = {
  /** The carrier the call was placed through. */
  carrier: "twilio";
  /** {@link PlacedCall.callId}. */
  callId: string;
  /** Explicit credentials; the step env otherwise. */
  credentials?: PlaceCallCredentials;
  signal?: AbortSignal;
};

// The status vocabulary and the "is it over" test live in `call-status.ts`
// (this file is at the source-length cap); re-exported so the `/step` barrel
// and every importer keep one path.
export { CALL_OVER_STATUSES, isCallOver, type PlacedCallStatus } from "./call-status.ts";

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

/** Where the host publishes this agent's public URL — {@link publishStepPublicUrl}. */
const STEP_PUBLIC_URL_SLOT = globalSlot<string>("stepPublicUrl");

/**
 * Publish this agent's public base URL, the default `agentUrl` of
 * {@link stepPlaceCall}. `undefined` (or blank) unpublishes.
 *
 * Called by whatever knows where the agent is reachable from the internet:
 * the guest harness (the platform's `AAI_PUBLIC_BASE_URL`) and
 * `createAgentServer` (its `publicUrl`, which `aai dev` fills).
 *
 * @internal — a host concern, exported from `@alexkroman1/aai/host-internal`.
 */
export function publishStepPublicUrl(url: string | undefined): void {
  STEP_PUBLIC_URL_SLOT.set(url?.trim() || undefined);
}

/** What {@link publishStepPublicUrl} last published — for a stub to put back. @internal */
export function publishedStepPublicUrl(): string | undefined {
  return STEP_PUBLIC_URL_SLOT.get();
}

/** Hosts a carrier on the internet can never reach. */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127\./.test(hostname)
  );
}

/**
 * The base URL Twilio is pointed at: the caller's, or the published one.
 * Throws (plain `Error`) when there is none, or it is loopback — Twilio would
 * dial and then fail to fetch the webhook, which a person hears as a call that
 * rings and goes silent.
 */
function answeringAgentUrl(explicit: string | undefined): string {
  const url = explicit ?? STEP_PUBLIC_URL_SLOT.get();
  if (url === undefined) {
    throw new Error(
      "no agentUrl, and this host published no public URL — deploy the agent, run " +
        "`aai dev --tunnel`, set `PUBLIC_URL`, or pass `agentUrl`",
    );
  }
  let hostname: string | undefined;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Malformed: `phoneWebhookUrl` refuses it with the sentence that says so.
  }
  if (hostname !== undefined && isLoopback(hostname)) {
    throw new Error(
      `agentUrl ${url} is loopback, which Twilio cannot reach — run \`aai dev --tunnel\` ` +
        "or set `PUBLIC_URL` to a public URL for this server",
    );
  }
  return url;
}

/** Longest one request to the carrier may take. */
const CARRIER_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Dial `to` from `from` and, once answered, stream the call to the agent at
 * `agentUrl` — this agent, unless another is named. Resolves the carrier's call
 * id as soon as the carrier ACCEPTS the
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
  const parameters = await callParameters(options);
  const request = (() => {
    try {
      return dialRequest(credentials, {
        to: options.to,
        from: options.from,
        agentUrl: answeringAgentUrl(options.agentUrl),
        parameters,
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

/**
 * The call's parameters: the caller's own, plus the signed brief when one is
 * given. Every refusal here is the caller's to fix, so none is retryable.
 */
async function callParameters(
  options: Pick<PlaceCallOptions, "parameters" | "brief" | "briefSecretEnv">,
): Promise<Readonly<Record<string, string>>> {
  const own = options.parameters ?? {};
  if (options.brief === undefined) return own;
  const refuse = (message: string): never => {
    throw new PlaceCallError(message, { carrier: "twilio", retryable: false });
  };
  const taken = Object.keys(own).find(isCallBriefParameter);
  if (taken !== undefined) {
    refuse(`parameters.${taken} collides with the brief, which is carried as call, sig and p0…pN.`);
  }
  const secretEnv = options.briefSecretEnv ?? CALL_BRIEF_SECRET_ENV;
  const secret = stepEnv(secretEnv)?.trim();
  if (!secret) refuse(`${secretEnv} is not set, and the call's brief is signed with it.`);
  try {
    return { ...own, ...(await signCallBrief(options.brief, secret ?? "")) };
  } catch (err: unknown) {
    return refuse(errorMessage(err));
  }
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
  return redactCredentials(
    [credentials.authToken, basicCredential(credentials), credentials.accountSid],
    text,
  );
}

/** One request to Twilio, its JSON answer on success and a {@link PlaceCallError} otherwise. */
async function send(
  credentials: PlaceCallCredentials,
  request: TwilioRequest,
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
