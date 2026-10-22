// Copyright 2026 the AAI authors. MIT license.
/**
 * `stubPlaceCall()` — Twilio's Calls API on the other end of `stepPlaceCall` /
 * `stepCallStatus`, for a spec of a workflow that dials.
 *
 * Shaped like `stubClientInbox`: it records every call placed and answers
 * each one. It is a published `stepFetch` rather than a slot of its own,
 * because that is what the two steps call — so a spec runs the SDK's real
 * request building, webhook URL encoding and refusal classification, and a staged
 * refusal is a Twilio STATUS and CODE that `stepPlaceCall` turns into its own
 * `PlaceCallError`, exactly as it would in production (the reasoning
 * `stubTranscribe` gives for staging a status rather than an error).
 *
 * Publishing a `stepFetch` REPLACES any other, so a flow that also calls
 * something else over `stepFetch` (its own database, a model) routes it through
 * `otherwise`.
 *
 * @module
 */

import {
  publishAnsweringStepFetch,
  type StubStepAnswer,
  type StubStepRequest,
} from "./_testing-step-fetch.ts";
import { TWILIO_API } from "./_twilio-calls.ts";
import { CALL_PARAMETER_PREFIX, callParametersFromQuery } from "./phone-webhook.ts";
import {
  type PlacedCallStatus,
  publishedStepPublicUrl,
  publishStepPublicUrl,
} from "./step-place-call.ts";

/**
 * One call a step placed, as {@link stubPlaceCall} records it.
 *
 * @sealed
 */
export type StubPlacedCall = {
  /** The call id the stub answered with (`CA` + a counter), or `undefined` for a refused dial. */
  callId: string | undefined;
  to: string;
  from: string;
  /**
   * The webhook Twilio fetches once the call is answered, WITHOUT the
   * parameters (they are {@link StubPlacedCall.parameters}):
   * `https://…/phone?carrier=twilio`.
   */
  webhookUrl: string | undefined;
  /** The `<Parameter>`s, decoded — what the answering session reads as `call.parameters`. */
  parameters: Record<string, string>;
  timeLimitS: number;
  ringTimeoutS: number;
  /** How many times {@link StubPlaceCallOptions.status} has been asked about this call. */
  polls: number;
};

/**
 * A Twilio refusal to stage: the HTTP status and, optionally, Twilio's error code and message.
 *
 * @input
 */
export type StubPlaceCallRefusal = { status: number; code?: number; message?: string };

/**
 * What {@link stubPlaceCall} may be told.
 *
 * @input
 */
export type StubPlaceCallOptions = {
  /**
   * How Twilio answers each dial: `"accept"` (the default), or a refusal —
   * `{ status: 400, code: 21219 }` is a trial account calling an unverified
   * number. A function answers per call.
   */
  dial?:
    | "accept"
    | StubPlaceCallRefusal
    | ((call: StubPlacedCall) => "accept" | StubPlaceCallRefusal);
  /**
   * What each status read answers: a status, or a function of the call (its
   * `polls` already counts this read). Default `"completed"`.
   */
  status?:
    | PlacedCallStatus
    | "initiated"
    | ((call: StubPlacedCall) => PlacedCallStatus | "initiated");
  /**
   * Every request that is not to Twilio's Calls API. Default: throw, naming it —
   * a request nobody set up is a finding (see `stubFetchRoutes`).
   */
  otherwise?: (request: StubStepRequest) => StubStepAnswer | Promise<StubStepAnswer>;
  /**
   * This agent's public URL while the stub is installed — what a deployment
   * publishes and `stepPlaceCall` dials back to when no `agentUrl` is passed.
   * Default `"https://agent.example.test"`; `restore()` puts back the previous one.
   */
  publicUrl?: string;
};

/**
 * What {@link stubPlaceCall} returns: the call log, and how to put the slot back.
 *
 * @sealed
 */
export type StubPlaceCall = {
  /** Every dial, in order — including refused ones. */
  calls: StubPlacedCall[];
  /** Unpublish the `stepFetch` and the public URL. Call it in an `afterEach`. */
  restore(): void;
};

const CALLS_PATH = /\/Accounts\/[^/]+\/Calls\.json$/;
const CALL_PATH = /\/Accounts\/[^/]+\/Calls\/([^/]+)\.json$/;

/** The dial's `Url`, split into the bare webhook and the parameters it carries. */
function webhookOf(raw: string | null): {
  webhookUrl: string | undefined;
  parameters: Record<string, string>;
} {
  if (raw === null) return { webhookUrl: undefined, parameters: {} };
  const url = new URL(raw);
  const parameters = callParametersFromQuery(url.searchParams);
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith(CALL_PARAMETER_PREFIX)) url.searchParams.delete(key);
  }
  return { webhookUrl: url.toString(), parameters };
}

function dialed(body: StubStepRequest["body"]): Omit<StubPlacedCall, "callId" | "polls"> {
  const form = new URLSearchParams(
    typeof body === "string" ? body : new TextDecoder().decode(body),
  );
  const { webhookUrl, parameters } = webhookOf(form.get("Url"));
  return {
    to: form.get("To") ?? "",
    from: form.get("From") ?? "",
    webhookUrl,
    parameters,
    timeLimitS: Number(form.get("TimeLimit")),
    ringTimeoutS: Number(form.get("Timeout")),
  };
}

function refusal(refused: StubPlaceCallRefusal): StubStepAnswer {
  return {
    status: refused.status,
    body: {
      code: refused.code,
      message: refused.message ?? `HTTP ${refused.status}`,
      status: refused.status,
    },
  };
}

/**
 * Publish a Twilio whose Calls API records every dial and answers it.
 *
 * @example
 * ```ts
 * import { stubPlaceCall } from "@alexkroman1/aai/testing";
 *
 * const twilio = stubPlaceCall({ status: (call) => (call.polls < 2 ? "ringing" : "completed") });
 * // … run the workflow, then read what it dialled, as the answering session sees it:
 * console.log(twilio.calls[0]?.parameters.call);
 * twilio.restore(); // in an `afterEach`
 * ```
 *
 * @public
 */
export function stubPlaceCall(options: StubPlaceCallOptions = {}): StubPlaceCall {
  const calls: StubPlacedCall[] = [];
  let next = 0;

  function answerDial(request: StubStepRequest): StubStepAnswer {
    const call: StubPlacedCall = { callId: undefined, polls: 0, ...dialed(request.body) };
    calls.push(call);
    const { dial = "accept" } = options;
    const answer = typeof dial === "function" ? dial(call) : dial;
    if (answer !== "accept") return refusal(answer);
    next += 1;
    call.callId = `CA${String(next).padStart(32, "0")}`;
    return { status: 201, body: { sid: call.callId, status: "queued" } };
  }

  function answerStatus(sid: string): StubStepAnswer {
    const call = calls.find((one) => one.callId === decodeURIComponent(sid));
    if (!call) return refusal({ status: 404, code: 20_404, message: "not found" });
    call.polls += 1;
    const { status = "completed" } = options;
    return {
      body: { sid: call.callId, status: typeof status === "function" ? status(call) : status },
    };
  }

  const previousPublicUrl = publishedStepPublicUrl();
  publishStepPublicUrl(options.publicUrl ?? "https://agent.example.test");
  const restoreFetch = publishAnsweringStepFetch(async (request) => {
    const { url } = request;
    const path = url.startsWith(TWILIO_API) ? url.slice(TWILIO_API.length) : "";
    if (request.method === "POST" && CALLS_PATH.test(path)) return answerDial(request);
    const sid = CALL_PATH.exec(path)?.[1];
    if (sid !== undefined && request.method === "GET") return answerStatus(sid);
    if (options.otherwise) return await options.otherwise(request);
    throw new Error(`stubPlaceCall: no route for ${request.method} ${url} (pass \`otherwise\`)`);
  });
  const restore = (): void => {
    restoreFetch();
    publishStepPublicUrl(previousPublicUrl);
  };
  return { calls, restore };
}
