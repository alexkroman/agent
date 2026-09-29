// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  CARRIER_CODECS,
  carrierByName,
  isMulawFormat,
  MAX_CALL_ID_CHARS,
  MAX_CALL_PARAMETER_CHARS,
  MAX_CALL_PARAMETERS,
  telnyxCodec,
  twilioCodec,
} from "./carriers.ts";

/** A realistic Twilio `start` frame, trimmed to the fields we read. */
const TWILIO_START = {
  event: "start",
  sequenceNumber: "1",
  streamSid: "MZ0123456789abcdef",
  start: {
    accountSid: "AC0123456789abcdef",
    callSid: "CA0123456789abcdef",
    tracks: ["inbound"],
    customParameters: { call: "c_81f2" },
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
  },
};

const TELNYX_START = {
  event: "start",
  sequence_number: "1",
  stream_id: "48c8a2a1-1f2e-4a1f-9b9c-000000000000",
  start: {
    call_control_id: "v3:abc",
    client_state: "aGVsbG8=",
    media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
  },
};

describe("twilioCodec", () => {
  test("decodes a start frame with its stream id and media format", () => {
    expect(twilioCodec.decode(TWILIO_START)).toEqual({
      kind: "start",
      streamId: "MZ0123456789abcdef",
      encoding: "audio/x-mulaw",
      sampleRate: 8000,
      // The call's identity — what an app that PLACED the call matches it by.
      callId: "CA0123456789abcdef",
      parameters: { call: "c_81f2" },
    });
  });

  test("bounds the custom parameters: strings only, capped in count and length", () => {
    // They arrive from the far end of an unauthenticated socket and land in the
    // app's `sessionContext`, so the app is handed a shape it need not check.
    const many = Object.fromEntries(
      Array.from({ length: MAX_CALL_PARAMETERS + 8 }, (_, i) => [`p${i}`, "v"]),
    );
    const decode = (customParameters: unknown) =>
      twilioCodec.decode({ event: "start", streamSid: "MZ0", start: { customParameters } });
    const kept = decode(many);
    expect(kept.kind === "start" && Object.keys(kept.parameters ?? {})).toHaveLength(
      MAX_CALL_PARAMETERS,
    );

    const mixed = decode({
      ok: "yes",
      number: 7,
      nested: { a: "b" },
      long: "x".repeat(MAX_CALL_PARAMETER_CHARS),
    });
    expect(mixed).toMatchObject({ parameters: { ok: "yes" } });
    expect(mixed.kind === "start" && Object.keys(mixed.parameters ?? {})).toEqual(["ok"]);
    // Not an object at all is no parameters, not a refused call.
    expect(decode("call=c_1")).toMatchObject({ kind: "start", parameters: {} });
  });

  test("a parameter named __proto__ is a parameter, not a prototype", () => {
    const decoded = twilioCodec.decode(
      JSON.parse('{"event":"start","start":{"customParameters":{"__proto__":"x"}}}'),
    );
    expect(decoded.kind === "start" && Object.keys(decoded.parameters ?? {})).toEqual([
      "__proto__",
    ]);
  });

  test("an over-long or empty call id is dropped", () => {
    const decode = (callSid: string) =>
      twilioCodec.decode({ event: "start", streamSid: "MZ0", start: { callSid } });
    expect(decode("C".repeat(MAX_CALL_ID_CHARS + 1))).toMatchObject({ callId: null });
    expect(decode("")).toMatchObject({ callId: null });
  });

  test("decodes a media frame to its base64 payload", () => {
    const frame = {
      event: "media",
      streamSid: "MZ0",
      media: { track: "inbound", chunk: "2", timestamp: "20", payload: "f39/fw==" },
    };
    expect(twilioCodec.decode(frame)).toEqual({ kind: "media", payload: "f39/fw==" });
  });

  test("ignores the agent's own audio echoed back on the outbound track", () => {
    // A both-tracks stream would otherwise transcribe the agent as the
    // caller, and every reply would read as a barge-in against itself.
    const frame = {
      event: "media",
      streamSid: "MZ0",
      media: { track: "outbound", payload: "f39/fw==" },
    };
    expect(twilioCodec.decode(frame)).toEqual({ kind: "ignore" });
  });

  test("decodes a stop frame", () => {
    expect(twilioCodec.decode({ event: "stop", streamSid: "MZ0", stop: {} })).toEqual({
      kind: "stop",
    });
  });

  test.each([
    ["connected", { event: "connected", protocol: "Call", version: "1.0.0" }],
    ["mark", { event: "mark", streamSid: "MZ0", mark: { name: "x" } }],
    ["dtmf", { event: "dtmf", streamSid: "MZ0", dtmf: { track: "inbound_track", digit: "1" } }],
    ["an unknown future frame", { event: "somethingNew", streamSid: "MZ0" }],
  ])("ignores a %s frame", (_label, frame) => {
    expect(twilioCodec.decode(frame)).toEqual({ kind: "ignore" });
  });

  test.each([
    ["null", null],
    ["a string", "not a frame"],
    ["an array", []],
    ["a media frame with no payload", { event: "media", media: {} }],
    ["a media frame with a non-string payload", { event: "media", media: { payload: 7 } }],
    ["an event-less object", { streamSid: "MZ0" }],
  ])("degrades %s to ignore rather than throwing", (_label, frame) => {
    // A carrier is free to add frame types, and a throw off a socket event
    // would take the host down mid-call over a field we never read.
    expect(() => twilioCodec.decode(frame)).not.toThrow();
    expect(twilioCodec.decode(frame)).toEqual({ kind: "ignore" });
  });

  test("tolerates a start frame missing its media format", () => {
    expect(twilioCodec.decode({ event: "start", streamSid: "MZ0", start: {} })).toEqual({
      kind: "start",
      streamId: "MZ0",
      encoding: null,
      sampleRate: null,
      callId: null,
      parameters: {},
    });
  });

  test("echoes streamSid on outbound frames", () => {
    // Twilio silently DROPS frames without it, which presents as an agent
    // that hears the caller and never speaks.
    expect(twilioCodec.media("AAAA", "MZ0")).toEqual({
      event: "media",
      streamSid: "MZ0",
      media: { payload: "AAAA" },
    });
    expect(twilioCodec.clear("MZ0")).toEqual({ event: "clear", streamSid: "MZ0" });
  });

  test("omits streamSid entirely when it is unknown", () => {
    expect(twilioCodec.media("AAAA", null)).toEqual({ event: "media", media: { payload: "AAAA" } });
    expect(twilioCodec.clear(null)).toEqual({ event: "clear" });
  });
});

describe("telnyxCodec", () => {
  test("decodes a snake-cased start frame", () => {
    expect(telnyxCodec.decode(TELNYX_START)).toEqual({
      kind: "start",
      streamId: "48c8a2a1-1f2e-4a1f-9b9c-000000000000",
      encoding: "PCMU",
      sampleRate: 8000,
      callId: "v3:abc",
      // Call Control's `client_state`, surfaced as a parameter, still base64.
      parameters: { client_state: "aGVsbG8=" },
    });
  });

  test("TeXML custom parameters ride beside client_state, and a real one of that name wins", () => {
    const decoded = telnyxCodec.decode({
      ...TELNYX_START,
      start: {
        ...TELNYX_START.start,
        custom_parameters: { call: "c_9", client_state: "from-texml" },
      },
    });
    expect(decoded).toMatchObject({ parameters: { call: "c_9", client_state: "from-texml" } });
  });

  test("decodes a media frame", () => {
    const frame = { event: "media", stream_id: "s", media: { track: "inbound", payload: "AAAA" } };
    expect(telnyxCodec.decode(frame)).toEqual({ kind: "media", payload: "AAAA" });
  });

  test("sends outbound frames with no stream id", () => {
    // Telnyx's documented outbound shape: the socket is the stream.
    expect(telnyxCodec.media("AAAA", "s")).toEqual({ event: "media", media: { payload: "AAAA" } });
    expect(telnyxCodec.clear("s")).toEqual({ event: "clear" });
  });

  test("does not read Twilio's camel-cased media format as its own", () => {
    const decoded = telnyxCodec.decode(TWILIO_START);
    expect(decoded).toMatchObject({ kind: "start", encoding: null });
  });
});

describe("carrierByName", () => {
  test.each([
    ["twilio", twilioCodec],
    ["telnyx", telnyxCodec],
  ])("resolves %s", (name, expected) => {
    expect(carrierByName(name)).toBe(expected);
  });

  test.each([
    ["an absent value", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("defaults to Twilio for %s", (_label, name) => {
    expect(carrierByName(name)).toBe(twilioCodec);
  });

  test("returns null for an unknown carrier rather than falling back", () => {
    // Falling back would serve Twilio framing to another carrier: a socket
    // that connects and then exchanges nothing in either direction.
    expect(carrierByName("vonage")).toBeNull();
  });

  test("every registered codec is keyed by its own name", () => {
    for (const [name, codec] of Object.entries(CARRIER_CODECS)) {
      expect(codec.name).toBe(name);
    }
  });
});

describe("isMulawFormat", () => {
  test.each([
    ["audio/x-mulaw", true],
    ["PCMU", true],
    ["pcmu", true],
    ["audio/x-ulaw", true],
    [null, true],
    ["audio/l16", false],
    ["opus", false],
  ])("%s → %s", (encoding, expected) => {
    expect(isMulawFormat(encoding)).toBe(expected);
  });
});
