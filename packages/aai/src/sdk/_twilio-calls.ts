// Copyright 2026 the AAI authors. MIT license.
/**
 * Twilio's Calls API as data: the requests `stepPlaceCall` / `stepCallStatus`
 * send, the TwiML that connects an answered call to an agent, the status
 * vocabulary, and the refusal codes a person can act on.
 *
 * Pure, and its own module for two readers: `step-place-call.ts` sends these,
 * and `testing-place-call.ts` (`stubPlaceCall`) reads them back — the stub parses
 * the TwiML this module wrote, so a spec asserts the parameters the answering
 * session will really see rather than a second rendering of them.
 *
 * @module
 */

import type { PlaceCallCredentials, PlacedCallStatus } from "./step-place-call.ts";

/** The credentials a request is signed with — `PlaceCallCredentials`, named here for the reader. */
export type TwilioCredentials = PlaceCallCredentials;

/** Where Twilio's REST API lives. */
export const TWILIO_API = "https://api.twilio.com/2010-04-01";

/** At most this many `<Parameter>`s — what the answering bridge keeps (`session-call.ts`). */
export const MAX_CALL_PARAMETERS = 32;
/** Twilio's limit on one `<Parameter>`'s name plus value. */
export const MAX_CALL_PARAMETER_CHARS = 500;
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

/**
 * XML-escape a value going into TwiML — all five specials, as numeric
 * references, so a quote in a parameter cannot close the attribute it is in.
 */
export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** {@link escapeXml} undone, plus the named entities an XML reader would also accept. */
function unescapeXml(value: string): string {
  const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  return value.replace(/&(#\d+|[a-z]+);/g, (whole, ref: string) =>
    ref.startsWith("#") ? String.fromCharCode(Number(ref.slice(1))) : (named[ref] ?? whole),
  );
}

/**
 * The stream URL for an agent's public base: `http(s)` becomes `ws(s)`, a
 * trailing slash is dropped, and `/phone?carrier=twilio` is appended.
 *
 * Throws on anything but an absolute `http(s)`/`ws(s)` URL with no query or
 * fragment — Twilio would dial the number and then fail to connect the audio,
 * which a person hears as a call that rings and goes silent.
 */
export function phoneStreamUrl(agentUrl: string): string {
  let url: URL;
  try {
    url = new URL(agentUrl);
  } catch (err: unknown) {
    throw new Error(`agentUrl is not a URL: ${JSON.stringify(agentUrl)}`, { cause: err });
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`agentUrl must be https:// or wss://, not ${url.protocol}`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("agentUrl must be a base URL, with no query or fragment");
  }
  const base = `${url.protocol.replace(/^http/, "ws")}//${url.host}${url.pathname}`;
  return `${base.replace(/\/+$/, "")}/phone?carrier=twilio`;
}

/** The TwiML that connects the answered call's audio to `streamUrl`, one `<Parameter>` each. */
export function callTwiml(streamUrl: string, parameters: Readonly<Record<string, string>>): string {
  const params = Object.entries(parameters)
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}"/>`)
    .join("");
  return `<Response><Connect><Stream url="${escapeXml(streamUrl)}">${params}</Stream></Connect></Response>`;
}

/**
 * The stream URL and parameters back out of TwiML {@link callTwiml} wrote.
 * Only for that TwiML — it is a reader of this module's own output, not of XML.
 */
export function parseCallTwiml(twiml: string): {
  streamUrl: string | undefined;
  parameters: Record<string, string>;
} {
  const url = /<Stream url="([^"]*)"/.exec(twiml)?.[1];
  const parameters: Record<string, string> = {};
  for (const [, name = "", value = ""] of twiml.matchAll(
    /<Parameter name="([^"]*)" value="([^"]*)"\/>/g,
  )) {
    parameters[unescapeXml(name)] = unescapeXml(value);
  }
  return { streamUrl: url === undefined ? undefined : unescapeXml(url), parameters };
}

function authorization(credentials: TwilioCredentials): string {
  return `Basic ${btoa(`${credentials.accountSid}:${credentials.authToken}`)}`;
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
  const entries = Object.entries(spec.parameters);
  if (entries.length > MAX_CALL_PARAMETERS) {
    throw new Error(`at most ${MAX_CALL_PARAMETERS} call parameters, got ${entries.length}`);
  }
  for (const [name, value] of entries) {
    if (
      typeof value !== "string" ||
      name === "" ||
      name.length + value.length >= MAX_CALL_PARAMETER_CHARS
    ) {
      throw new Error(
        `call parameter ${JSON.stringify(name.slice(0, 40))} must be a non-empty name and a ` +
          `string value, together under ${MAX_CALL_PARAMETER_CHARS} characters`,
      );
    }
  }
  const form = new URLSearchParams({
    To: spec.to.trim(),
    From: spec.from.trim(),
    Twiml: callTwiml(phoneStreamUrl(spec.agentUrl), spec.parameters),
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
