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

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";

/** One inbound carrier frame, reduced to what a session needs. */
export type CarrierInbound =
  /** The call's media stream has begun; `streamId` must be echoed on outbound frames. */
  | { kind: "start"; streamId: string; encoding: string | null; sampleRate: number | null }
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
 * Shared decoding, parameterized by the two field names carriers disagree on.
 *
 * Both vendors use the same `event` discriminator and the same nested `media`
 * object, so writing this twice would mean two places to get the track guard
 * wrong.
 */
function decodeWith(
  frame: unknown,
  keys: { streamId: string; mediaFormat: string; encoding: string; sampleRate: string },
): CarrierInbound {
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
    return {
      kind: "start",
      // Twilio repeats the id at the top level of every frame; Telnyx does
      // too. Fall back to the `start` body for a carrier that only puts it
      // there, then to the empty string — an unusable id is not a reason to
      // refuse a call whose audio is otherwise fine.
      streamId: stringAt(record, keys.streamId) ?? stringAt(start, keys.streamId) ?? "",
      encoding: stringAt(format, keys.encoding),
      sampleRate: numberAt(format, keys.sampleRate),
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
 * Snake-cased where Twilio is camel-cased, and its documented outbound frames
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
    }),
  media: (payload) => ({ event: "media", media: { payload } }),
  clear: () => ({ event: "clear" }),
};

/** Every carrier this build can serve, keyed by its `?carrier=` value. */
export const CARRIER_CODECS = {
  [twilioCodec.name]: twilioCodec,
  [telnyxCodec.name]: telnyxCodec,
} as const satisfies Record<string, CarrierCodec>;

/** A carrier name this build can serve. */
export type CarrierName = keyof typeof CARRIER_CODECS;

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
