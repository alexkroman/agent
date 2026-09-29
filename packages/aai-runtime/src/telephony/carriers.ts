// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-carrier framing for bidirectional media streaming.
 *
 * Twilio Media Streams and Telnyx media streaming are the same protocol in
 * outline — a WebSocket the carrier opens to us, carrying JSON frames that
 * wrap base64 μ-law — and differ only in field names and in which identifier
 * an outbound frame has to echo. That difference is the whole of this file:
 * everything downstream of {@link CarrierCodec} is vendor-neutral, so a third
 * carrier is a new codec here and no change anywhere else.
 *
 * **Frames are narrowed by hand rather than by a Zod schema**, unlike the
 * client protocol in `sdk/protocol.ts`. These are data-plane frames: `media`
 * arrives every 20 ms in each direction for the life of every call, which is
 * the same path the client protocol carries as raw binary and does not parse
 * at all. The shapes are four fields deep and fully covered by
 * `carriers.test.ts`, so the schema would buy validation we already have at a
 * cost we would pay 50 times a second per call.
 *
 * Decoding NEVER throws. A carrier is free to add frame types (Twilio has
 * added several), and an unrecognized or malformed frame must degrade to
 * "ignore" — throwing here would take down a live call over a field we had no
 * reason to read.
 */

import type { TELEPHONY_CARRIERS } from "@alexkroman1/aai/internal";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";

/** The carriers the SDK ships — `TelephonyCarrier` itself is open (`| (string & {})`). */
type ShippedCarrier = (typeof TELEPHONY_CARRIERS)[number];

/** One inbound carrier frame, reduced to what a session needs. */
export type CarrierInbound =
  /**
   * The call's media stream has begun; `streamId` must be echoed on outbound
   * frames. `callId` and `parameters` are the call's identity, bounded by the
   * shipped codecs (see `MAX_CALL_PARAMETERS`). OPTIONAL so a codec written
   * before they existed still type-checks; absent reads as "none".
   */
  | {
      kind: "start";
      streamId: string;
      encoding: string | null;
      sampleRate: number | null;
      callId?: string | null;
      parameters?: Readonly<Record<string, string>>;
    }
  /** One 20 ms chunk of caller audio, base64 μ-law. */
  | { kind: "media"; payload: string }
  /** The carrier is ending the stream (the caller hung up). */
  | { kind: "stop" }
  /** Anything we do not act on: keepalives, marks, DTMF, unknown frame types. */
  | { kind: "ignore" };

/** Translates between a carrier's JSON frames and the two things a session needs. */
export type CarrierCodec = {
  /** Vendor name, for logs and for the `?carrier=` query value. */
  readonly name: string;
  /** Reduce one parsed inbound frame. Never throws. */
  decode(frame: unknown): CarrierInbound;
  /** An outbound frame carrying one chunk of base64 μ-law agent speech. */
  media(payload: string, streamId: string | null): unknown;
  /**
   * The frame that discards agent audio the carrier has already buffered.
   *
   * This is what makes barge-in audible on a phone call. The carrier accepts
   * audio far faster than it plays it, so at the moment the caller interrupts
   * there are seconds of the agent's reply sitting in the carrier's own
   * buffer — beyond the reach of anything the session drops on its side. Sent
   * on `cancelled`/`reset`; without it the caller talks over an agent that
   * keeps speaking for several seconds after being interrupted.
   */
  clear(streamId: string | null): unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringAt(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function numberAt(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whether a media frame carries the CALLER's audio.
 *
 * A carrier configured to stream both directions echoes the agent's own
 * speech back on an `outbound` track. Feeding that to STT would transcribe
 * the agent as if it were the caller — and, worse, every reply would read as
 * a barge-in against itself. An absent track means a single-track stream,
 * which is the caller.
 */
function isCallerTrack(media: Record<string, unknown> | null): boolean {
  const track = stringAt(media, "track");
  return track === null || track === "inbound" || track === "inbound_track";
}

/**
 * Most custom parameters kept from one `start` frame. Twilio documents no count
 * limit, so this is ours: a placed call carries a handful, and the object is
 * held per session for the life of the process's session map.
 */
export const MAX_CALL_PARAMETERS = 32;

/**
 * Longest parameter kept, name and value together — Twilio's own documented
 * limit ("the combined length of each `<Parameter>` name and value must be under
 * 500 characters"), so nothing a real Twilio call carries is dropped.
 */
export const MAX_CALL_PARAMETER_CHARS = 500;

/** Longest call id kept. A Twilio `CallSid` is 34; a Telnyx `call_control_id` is ~70. */
export const MAX_CALL_ID_CHARS = 128;

/**
 * A `start` frame's custom parameters, bounded.
 *
 * They cross from the far end of an unauthenticated socket into an app's
 * `sessionContext`, so they are held to a shape the app can read without
 * checking: a string value, a non-empty name, at most
 * {@link MAX_CALL_PARAMETERS} of them, each under
 * {@link MAX_CALL_PARAMETER_CHARS}. Anything else is dropped rather than
 * refused — a malformed parameter is not a reason to hang up a call whose audio
 * is fine, and an app that needs one it did not get refuses the session itself.
 * A null-prototype object, so a parameter named `__proto__` is a parameter.
 */
function decodeCallParameters(...sources: unknown[]): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  let kept = 0;
  for (const source of sources) {
    const record = asRecord(source);
    if (record === null) continue;
    for (const [name, value] of Object.entries(record)) {
      if (kept >= MAX_CALL_PARAMETERS) return out;
      if (typeof value !== "string" || name === "" || name in out) continue;
      if (name.length + value.length >= MAX_CALL_PARAMETER_CHARS) continue;
      out[name] = value;
      kept++;
    }
  }
  return out;
}

/** The call id, or null when absent, empty or over {@link MAX_CALL_ID_CHARS}. */
function callIdAt(record: Record<string, unknown> | null, key: string): string | null {
  const id = stringAt(record, key);
  return id === null || id === "" || id.length > MAX_CALL_ID_CHARS ? null : id;
}

/** The field names a carrier's `start` frame uses — see {@link decodeWith}. */
type StartKeys = {
  streamId: string;
  mediaFormat: string;
  encoding: string;
  sampleRate: string;
  /** The call's id inside `start`. */
  callId: string;
  /** The custom-parameter object inside `start`. */
  parameters: string;
  /**
   * A single string inside `start` surfaced AS a parameter of the same name —
   * Telnyx's `client_state`, which is where Call Control puts what an app
   * attached to the call. A real custom parameter of that name wins.
   */
  stateParameter?: string;
};

/**
 * Shared decoding, parameterized by the field names carriers disagree on.
 *
 * Both vendors use the same `event` discriminator and the same nested `media`
 * object, so writing this twice would mean two places to get the track guard
 * wrong.
 */
function decodeWith(frame: unknown, keys: StartKeys): CarrierInbound {
  const record = asRecord(frame);
  const event = stringAt(record, "event");
  if (event === "media") {
    const media = asRecord(record?.media);
    const payload = stringAt(media, "payload");
    if (payload === null || !isCallerTrack(media)) return { kind: "ignore" };
    return { kind: "media", payload };
  }
  if (event === "start") {
    const start = asRecord(record?.start);
    const format = asRecord(start?.[keys.mediaFormat]);
    const state = keys.stateParameter === undefined ? null : stringAt(start, keys.stateParameter);
    return {
      kind: "start",
      // Twilio repeats the id at the top level of every frame; Telnyx does
      // too. Fall back to the `start` body for a carrier that only puts it
      // there, then to the empty string — an unusable id is not a reason to
      // refuse a call whose audio is otherwise fine.
      streamId: stringAt(record, keys.streamId) ?? stringAt(start, keys.streamId) ?? "",
      encoding: stringAt(format, keys.encoding),
      sampleRate: numberAt(format, keys.sampleRate),
      callId: callIdAt(start, keys.callId),
      parameters: decodeCallParameters(
        start?.[keys.parameters],
        state === null ? null : { [keys.stateParameter as string]: state },
      ),
    };
  }
  if (event === "stop") return { kind: "stop" };
  return { kind: "ignore" };
}

/**
 * Twilio Media Streams (`<Connect><Stream>`).
 *
 * Outbound frames MUST echo `streamSid`; Twilio silently drops frames without
 * it, which presents as an agent that hears the caller and never speaks.
 */
export const twilioCodec: CarrierCodec = {
  name: "twilio",
  decode: (frame) =>
    decodeWith(frame, {
      streamId: "streamSid",
      mediaFormat: "mediaFormat",
      encoding: "encoding",
      sampleRate: "sampleRate",
      callId: "callSid",
      parameters: "customParameters",
    }),
  // `omitUndefined` rather than a conditional spread of an object literal, which
  // is what `guard-invariants` rule 2 asks for wherever the guard IS the value:
  // a carrier that puts no id on the wire simply has no `streamSid` key.
  media: (payload, streamId) =>
    omitUndefined({
      event: "media",
      streamSid: streamId ?? undefined,
      media: { payload },
    }),
  clear: (streamId) => omitUndefined({ event: "clear", streamSid: streamId ?? undefined }),
};

/**
 * Telnyx media streaming.
 *
 * Snake-cased where Twilio is camel-cased — the call id is `call_control_id`,
 * and `client_state` (base64, as Telnyx sends it) is surfaced as a parameter —
 * and its documented outbound frames
 * carry no stream id at all — the socket is the stream. Written to Telnyx's
 * documented shape; the inbound half also accepts Twilio's spelling of the
 * id, which costs nothing and covers a carrier that echoes it.
 */
export const telnyxCodec: CarrierCodec = {
  name: "telnyx",
  decode: (frame) =>
    decodeWith(frame, {
      streamId: "stream_id",
      mediaFormat: "media_format",
      encoding: "encoding",
      sampleRate: "sample_rate",
      callId: "call_control_id",
      // TeXML's `<Parameter>` elements. Telnyx documents that they ride on the
      // `start` message without naming the key in its reference; this is the
      // snake-cased spelling of Twilio's, which is the convention every other
      // Telnyx field follows. Call Control's `client_state` is the documented
      // half, and is surfaced as a parameter of that name.
      parameters: "custom_parameters",
      stateParameter: "client_state",
    }),
  media: (payload) => ({ event: "media", media: { payload } }),
  clear: () => ({ event: "clear" }),
};

/**
 * Every carrier this build can serve, keyed by its `?carrier=` value.
 *
 * `satisfies Record<ShippedCarrier, CarrierCodec>` rather than
 * `Record<string, …>`, which is what ties this table to the vocabulary an agent
 * DECLARES in `agent({ telephony: [...] })`: the SDK owns the names, this owns
 * the framing, and the two must not be able to disagree. A name added to
 * `TELEPHONY_CARRIERS` with no codec here fails this package's build instead of
 * shipping a carrier an author can enable and nothing can answer.
 */
export const CARRIER_CODECS = {
  // Literal keys rather than `[twilioCodec.name]`: a computed key is `string`
  // (a `CarrierCodec`'s `name` is deliberately wide, so an embedder can write
  // a codec for a carrier this build has never heard of), which widens the
  // whole table and takes the `satisfies` below with it. `carriers.test.ts`
  // asserts each key still equals the codec's own name.
  twilio: twilioCodec,
  telnyx: telnyxCodec,
} as const satisfies Record<ShippedCarrier, CarrierCodec>;

/**
 * A carrier's name — the `?carrier=` value, and what a `telephony` declaration
 * lists.
 *
 * `string` rather than `keyof typeof CARRIER_CODECS`, which was a CLOSED union
 * on a published type: every carrier this build learned to frame would have
 * been a changed union, i.e. a breaking change to a type an embedder only
 * passes in. Which names this build can actually serve is decided at run time,
 * where it has to be anyway — {@link carrierByName} answers null for an unknown
 * one and the server refuses the upgrade naming it, and a declaration naming a
 * carrier with no codec here is dropped rather than refused (`enabledCarriers`).
 */
export type CarrierName = string;

/**
 * The codec for a `?carrier=` value.
 *
 * Defaults to Twilio for an absent value — the common case, and a default
 * keeps the TwiML that a hand-written integration produces free of a query
 * string. An UNKNOWN value returns null rather than falling back: silently
 * serving Twilio framing to a Telnyx call produces a connected socket that
 * exchanges nothing either way, which is a much worse thing to debug than a
 * refused upgrade.
 */
export function carrierByName(name: string | null | undefined): CarrierCodec | null {
  if (name === undefined || name === null || name === "") return twilioCodec;
  return (CARRIER_CODECS as Record<string, CarrierCodec>)[name] ?? null;
}

/**
 * Whether a carrier-declared media format is the μ-law this bridge decodes.
 *
 * Twilio says `audio/x-mulaw`, Telnyx says `PCMU`; both mean G.711 μ-law. An
 * unrecognized value is only ever WARNED about, never refused — the format
 * field is informational, the audio is what it is, and refusing a call over a
 * spelling we have not seen before would be the wrong failure.
 */
export function isMulawFormat(encoding: string | null): boolean {
  if (encoding === null) return true;
  const normalized = encoding.toLowerCase();
  return normalized.includes("mulaw") || normalized.includes("ulaw") || normalized === "pcmu";
}
