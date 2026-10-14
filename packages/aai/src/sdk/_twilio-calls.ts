// Copyright 2026 the AAI authors. MIT license.
/**
 * Twilio's Calls API as data: the requests `stepPlaceCall` / `stepCallStatus`
 * send, the status vocabulary, and the refusal codes a person can act on. The
 * webhook a dial points the call at is `phone-webhook.ts`'s.
 *
 * Pure, and its own module for two readers: `step-place-call.ts` sends these,
 * and `testing-place-call.ts` (`stubPlaceCall`) reads them back — the stub parses
 * the webhook URL this module wrote, so a spec asserts the parameters the
 * answering session will really see rather than a second rendering of them.
 *
 * @module
 */

import { phoneWebhookUrl } from "./phone-webhook.ts";
import type { PlaceCallCredentials, PlacedCallStatus } from "./step-place-call.ts";

/** The credentials a request is signed with — `PlaceCallCredentials`, named here for the reader. */
export type TwilioCredentials = PlaceCallCredentials;

/** Where Twilio's REST API lives. */
export const TWILIO_API = "https://api.twilio.com/2010-04-01";

/** Twilio's ceiling on `TimeLimit` (four hours). */
const MAX_TIME_LIMIT_S = 14_400;
/** Twilio's ceiling on `Timeout`. */
const MAX_RING_TIMEOUT_S = 600;

/** A request, in the shape `stepFetch` takes. */
export type TwilioRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

/** What a dial names, after defaults. */
export type DialSpec = {
  to: string;
  from: string;
  agentUrl: string;
  parameters: Readonly<Record<string, string>>;
  timeLimitS: number;
  ringTimeoutS: number;
};

/** The Basic credential Twilio's API authenticates with: `sid:token`, base64. */
export function basicCredential(credentials: TwilioCredentials): string {
  return btoa(`${credentials.accountSid}:${credentials.authToken}`);
}

function authorization(credentials: TwilioCredentials): string {
  return `Basic ${basicCredential(credentials)}`;
}

function accountUrl(credentials: TwilioCredentials): string {
  return `${TWILIO_API}/Accounts/${encodeURIComponent(credentials.accountSid)}`;
}

function wholeSeconds(name: string, value: number, max: number): string {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be a whole number of seconds from 1 to ${max}, got ${value}`);
  }
  return String(value);
}

/** The `POST …/Calls.json` for one dial. Throws (plain `Error`) on a malformed spec. */
export function dialRequest(credentials: TwilioCredentials, spec: DialSpec): TwilioRequest {
  if (spec.to.trim() === "") throw new Error("`to` is empty: pass the number to call, E.164");
  if (spec.from.trim() === "")
    throw new Error("`from` is empty: pass a number on the Twilio account");
  const form = new URLSearchParams({
    To: spec.to.trim(),
    From: spec.from.trim(),
    // A WEBHOOK, never inline `Twiml`: only a webhook works on the managed
    // platform, and it lifts Twilio's 4,000-character cap on inline TwiML off
    // the parameters. See `phone-webhook.ts`.
    Url: phoneWebhookUrl(spec.agentUrl, "twilio", spec.parameters),
    Method: "POST",
    TimeLimit: wholeSeconds("timeLimitS", spec.timeLimitS, MAX_TIME_LIMIT_S),
    Timeout: wholeSeconds("ringTimeoutS", spec.ringTimeoutS, MAX_RING_TIMEOUT_S),
  });
  return {
    url: `${accountUrl(credentials)}/Calls.json`,
    method: "POST",
    headers: {
      Authorization: authorization(credentials),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  };
}

/** The `GET …/Calls/<sid>.json` for one status read. */
export function callStatusRequest(credentials: TwilioCredentials, callId: string): TwilioRequest {
  return {
    url: `${accountUrl(credentials)}/Calls/${encodeURIComponent(callId)}.json`,
    method: "GET",
    headers: { Authorization: authorization(credentials) },
  };
}

/** Every {@link PlacedCallStatus}, which is Twilio's own vocabulary less `initiated`. */
const STATUSES: ReadonlySet<string> = new Set<PlacedCallStatus>([
  "queued",
  "ringing",
  "in-progress",
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
]);

/** Twilio's status string as the normalized union; `initiated` is `queued`; unknown is `undefined`. */
export function normalizeCallStatus(raw: unknown): PlacedCallStatus | undefined {
  if (raw === "initiated") return "queued";
  return typeof raw === "string" && STATUSES.has(raw) ? (raw as PlacedCallStatus) : undefined;
}

/**
 * The sentence for a Twilio refusal. The codes here are the ones a person
 * setting up calling hits and can fix; any other keeps Twilio's own message.
 * Never names the token — and the caller redacts anyway.
 */
export function twilioAdvice(code: number | undefined, message: string, status: number): string {
  const tail = ` (Twilio ${code === undefined ? `HTTP ${status}` : `error ${code}`})`;
  switch (code) {
    case 20_003:
      return `Twilio rejected the account SID or auth token: check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.${tail}`;
    case 21_211:
    case 21_217:
      return `That isn't a phone number Twilio can call: pass \`to\` as E.164 (+ and country code).${tail}`;
    case 21_210:
    case 21_212:
      return `The number to call from isn't a verified caller id or a number on the Twilio account: check \`from\`.${tail}`;
    case 21_219:
      return `A Twilio trial account can only call numbers verified on the account: verify this one, or upgrade.${tail}`;
    case 21_215:
      return `Twilio's geographic permissions don't allow calling that country: enable it under Voice > Geo Permissions.${tail}`;
    default:
      return `Twilio couldn't place the call: ${message}${tail}`;
  }
}
