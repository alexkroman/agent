// Copyright 2026 the AAI authors. MIT license.
import type { SessionErrorCode, SessionEventBody } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import { MockWebSocket } from "../_mock-ws.ts";
import { makeLogger } from "../_test-utils.ts";
import type { SessionRuntime } from "../server.ts";
import { telnyxCodec, twilioCodec } from "./carriers.ts";
import { mulawToPcm16, pcm16ToMulaw, TELEPHONY_SAMPLE_RATE } from "./mulaw.ts";
import { createTelephonyBridge } from "./telephony-bridge.ts";
import { startTelephonySession } from "./telephony-server.ts";

const SESSION_RATE = 16_000;
const TTS_RATE = 24_000;
/** One carrier frame: 20 ms of 8 kHz μ-law. */
const FRAME_SAMPLES = TELEPHONY_SAMPLE_RATE / 50;

/**
 * The frame the SESSION really emits, typed so it cannot drift again.
 *
 * It used to be a hand-written `{ type: "config", … }` — a shape no runtime
 * sends — so every test in this file passed while the bridge configured itself
 * on nothing and a real call went deaf in both directions. `SessionEventBody`
 * is the protocol's own union, so a rename now fails to COMPILE here instead of
 * failing silently on a phone.
 */
function configFrame(sampleRate = SESSION_RATE, ttsSampleRate = TTS_RATE): string {
  const event: SessionEventBody = {
    type: "session.configured",
    audioFormat: "pcm16",
    sampleRate,
    ttsSampleRate,
    sessionId: "sess_test",
  };
  return JSON.stringify(event);
}

/** An `error.reported` frame, typed against the protocol like {@link configFrame}. */
function errorFrame(opts: { fatal: boolean; code: SessionErrorCode }): string {
  const event: SessionEventBody = {
    type: "error.reported",
    code: opts.code,
    message: "provider connect failed",
    fatal: opts.fatal,
  };
  return JSON.stringify(event);
}

/** A μ-law payload of `samples` sine samples, base64'd as a carrier sends it. */
function mulawPayload(samples: number, frequency = 440): string {
  const pcm = Int16Array.from({ length: samples }, (_, i) =>
    Math.round(20_000 * Math.sin((2 * Math.PI * frequency * i) / TELEPHONY_SAMPLE_RATE)),
  );
  return Buffer.from(pcm16ToMulaw(pcm)).toString("base64");
}

/**
 * A bridge over an already-open mock carrier socket, plus the frames it receives.
 *
 * The logger is `makeLogger()`, NOT the shared `silentLogger` this file used to
 * shadow by name: that one is plain no-ops precisely so it cannot be asserted
 * on, and these specs DO assert on theirs (the two `logger.warn` checks below).
 */
function setup(carrier = twilioCodec) {
  const socket = new MockWebSocket("ws://carrier.test/phone");
  socket.open();
  const logger = makeLogger();
  const bridge = createTelephonyBridge(socket, { carrier, logger });
  const inbound: unknown[] = [];
  bridge.addEventListener("message", (event: { data: unknown }) => inbound.push(event.data));
  return { socket, bridge, inbound, logger };
}

/** Drive the handshake a real session performs: config out, carrier start in. */
function connect(fixture: ReturnType<typeof setup>, streamSid = "MZ0"): void {
  fixture.bridge.send(configFrame());
  fixture.socket.msg(
    JSON.stringify({
      event: "start",
      streamSid,
      start: { mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } },
    }),
  );
}

describe("createTelephonyBridge", () => {
  test("greets the caller: a carrier start becomes an audio_ready frame", () => {
    // audio_ready is what releases the agent's opening line. Without it the
    // call connects to silence and the caller has to speak first.
    const fixture = setup();
    connect(fixture);
    expect(fixture.inbound).toEqual([JSON.stringify({ type: "audio_ready" })]);
  });

  test("converts caller audio to PCM16 at the session's input rate", () => {
    const fixture = setup();
    connect(fixture);
    fixture.socket.msg(
      JSON.stringify({ event: "media", streamSid: "MZ0", media: { payload: mulawPayload(160) } }),
    );

    const audio = fixture.inbound.at(-1);
    expect(audio).toBeInstanceOf(Uint8Array);
    // 160 samples at 8 kHz is 20 ms; at 16 kHz that is 320 samples = 640 bytes.
    // A swapped resampler pair would produce 80 samples here.
    expect((audio as Uint8Array).byteLength).toBe(640);
  });

  test("converts agent audio to base64 μ-law at 8 kHz", () => {
    const fixture = setup();
    connect(fixture);
    fixture.socket.sent.length = 0;

    // 480 PCM16 samples at 24 kHz is 20 ms of TTS output.
    const speech = new Int16Array(480);
    fixture.bridge.send(new Uint8Array(speech.buffer));

    const [frame] = fixture.socket.sentJson();
    expect(frame).toMatchObject({ event: "media", streamSid: "MZ0" });
    const payload = (frame as { media: { payload: string } }).media.payload;
    // 20 ms at 8 kHz μ-law is exactly 160 bytes, one byte per sample.
    expect(Buffer.from(payload, "base64")).toHaveLength(FRAME_SAMPLES);
  });

  test("preserves a caller tone through the inbound conversion", () => {
    // End-to-end proof the μ-law and resampling stages are composed in the
    // right order and direction — a transposition still produces plausible
    // byte counts but destroys the signal.
    const fixture = setup();
    connect(fixture);
    for (let i = 0; i < 10; i++) {
      fixture.socket.msg(
        JSON.stringify({ event: "media", media: { payload: mulawPayload(160, 440) } }),
      );
    }
    const chunks = fixture.inbound.filter((d): d is Uint8Array => d instanceof Uint8Array);
    const last = chunks.at(-1) as Uint8Array;
    const pcm = new Int16Array(last.buffer, last.byteOffset, last.byteLength / 2);
    let peak = 0;
    for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
    // The source tone is ±20 000; μ-law and linear interpolation cost a few
    // percent, and nothing else should touch the level.
    expect(peak).toBeGreaterThan(17_000);
    expect(peak).toBeLessThan(22_000);
  });

  test("sends the carrier a clear frame on barge-in", () => {
    // The carrier buffers seconds of the reply beyond anything the session
    // can drop on its own side. Without this the caller talks over an agent
    // that keeps speaking after being interrupted.
    const fixture = setup();
    connect(fixture);
    fixture.socket.sent.length = 0;

    fixture.bridge.send(JSON.stringify({ type: "reply.cancelled" }));
    expect(fixture.socket.sentJson()).toEqual([{ event: "clear", streamSid: "MZ0" }]);
  });

  test("sends a clear frame on reset too", () => {
    const fixture = setup();
    connect(fixture);
    fixture.socket.sent.length = 0;

    // `session.reset` is what `session-commands.ts` emits — the spelling this
    // spec used to feed the bridge (`reset`) is one no runtime produces, so it
    // passed while the branch it covered was dead.
    fixture.bridge.send(JSON.stringify({ type: "session.reset" }));
    expect(fixture.socket.sentJson()).toEqual([{ event: "clear", streamSid: "MZ0" }]);
  });

  test.each([
    ["agent_transcript", { type: "agent-transcript.updated", text: "hello" }],
    // Guards the spelling above: a bare `reset` is not a protocol event, and a
    // branch that answers one is a branch nothing on the wire reaches.
    ["bare reset", { type: "reset" }],
    ["user_transcript", { type: "user-transcript.committed", text: "hi" }],
    ["tool_call", { type: "tool.called", toolCallId: "1", toolName: "x", args: {} }],
    ["reply_done", { type: "reply.completed" }],
    ["audio_done", { type: "audio.completed" }],
    ["agent_state", { type: "state.updated", state: {} }],
  ])("sends the carrier nothing for a %s event", (_label, event) => {
    const fixture = setup();
    connect(fixture);
    fixture.socket.sent.length = 0;

    fixture.bridge.send(JSON.stringify(event));
    expect(fixture.socket.sent).toEqual([]);
  });

  test("closes the socket when the carrier stops the stream", () => {
    const fixture = setup();
    connect(fixture);
    fixture.socket.msg(JSON.stringify({ event: "stop", streamSid: "MZ0" }));
    expect(fixture.socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  test("ends the call when the session reports a FATAL error", () => {
    // A phone has no screen, and that is the whole reason this branch exists.
    // `error.reported` carries `fatal`, documented as "the session is over",
    // and `aai-ui` answers it by releasing the microphone and ending the call.
    // The bridge used to sort it with the transcripts and tool calls under
    // "everything else is for a screen", so a call whose STT and TTS both
    // failed to connect stayed OPEN. Measured against a real `/phone` socket
    // on `aai dev`: both providers 403'd, the session emitted two fatal
    // `error.reported` frames, and the socket was still open 45 seconds later
    // — dead air on a billed PSTN call, ended only by the caller hanging up.
    const fixture = setup();
    connect(fixture);
    fixture.bridge.send(errorFrame({ fatal: true, code: "tts" }));
    expect(fixture.socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  test("a NON-fatal error leaves the call up", () => {
    // The other half, and the reason the flag is REQUIRED in the protocol:
    // a turn-level failure the session survives must not drop a live call.
    const fixture = setup();
    connect(fixture);
    fixture.bridge.send(errorFrame({ fatal: false, code: "tool" }));
    expect(fixture.socket.readyState).toBe(MockWebSocket.OPEN);
  });

  test("drops caller audio that arrives before the config frame", () => {
    // Unreachable against a real runtime (config is the first thing it
    // sends), but the rates are unknown until then and guessing would put
    // wrong-speed audio into STT rather than failing.
    const fixture = setup();
    fixture.socket.msg(JSON.stringify({ event: "media", media: { payload: mulawPayload(160) } }));
    expect(fixture.inbound).toEqual([]);
  });

  test("warns rather than throwing when agent audio precedes the config frame", () => {
    const fixture = setup();
    expect(() => fixture.bridge.send(new Uint8Array(960))).not.toThrow();
    expect(fixture.socket.sent).toEqual([]);
    expect(fixture.logger.warn).toHaveBeenCalled();
  });

  test("replays frames that arrived before a listener was attached", () => {
    const socket = new MockWebSocket("ws://carrier.test/phone");
    socket.open();
    const bridge = createTelephonyBridge(socket, { carrier: twilioCodec, logger: makeLogger() });
    // A start landing here would otherwise cost the greeting — the opening of
    // every call — to event-loop ordering.
    socket.msg(JSON.stringify({ event: "start", streamSid: "MZ0", start: {} }));

    const inbound: unknown[] = [];
    bridge.addEventListener("message", (event: { data: unknown }) => inbound.push(event.data));
    expect(inbound).toEqual([JSON.stringify({ type: "audio_ready" })]);
  });

  test("survives a malformed carrier frame without throwing", () => {
    const fixture = setup();
    connect(fixture);
    expect(() => fixture.socket.msg("{not json")).not.toThrow();
    expect(() => fixture.socket.msg(JSON.stringify({ event: "media", media: null }))).not.toThrow();
  });

  test("reads a carrier frame delivered as binary", () => {
    const fixture = setup();
    fixture.bridge.send(configFrame());
    const bytes = Buffer.from(JSON.stringify({ event: "start", streamSid: "MZ0", start: {} }));
    fixture.socket.simulateMessage(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    expect(fixture.inbound).toEqual([JSON.stringify({ type: "audio_ready" })]);
  });

  test("warns about an unexpected media format but still serves the call", () => {
    const fixture = setup();
    fixture.bridge.send(configFrame());
    fixture.socket.msg(
      JSON.stringify({
        event: "start",
        streamSid: "MZ0",
        start: { mediaFormat: { encoding: "audio/l16", sampleRate: 16_000 } },
      }),
    );
    expect(fixture.logger.warn).toHaveBeenCalled();
    expect(fixture.inbound).toEqual([JSON.stringify({ type: "audio_ready" })]);
  });

  test("passes readyState and close through to the carrier socket", () => {
    const fixture = setup();
    expect(fixture.bridge.readyState).toBe(MockWebSocket.OPEN);
    fixture.bridge.close?.(1011, "internal");
    expect(fixture.socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  test("forwards the carrier's close event to the session", () => {
    const fixture = setup();
    const onClose = vi.fn();
    fixture.bridge.addEventListener("close", onClose);
    fixture.socket.disconnect(1000);
    expect(onClose).toHaveBeenCalled();
  });

  test("uses the carrier's own framing — Telnyx omits the stream id", () => {
    const fixture = setup(telnyxCodec);
    fixture.bridge.send(configFrame());
    fixture.socket.msg(
      JSON.stringify({
        event: "start",
        stream_id: "s1",
        start: { media_format: { encoding: "PCMU", sample_rate: 8000 } },
      }),
    );
    fixture.socket.sent.length = 0;

    fixture.bridge.send(JSON.stringify({ type: "reply.cancelled" }));
    expect(fixture.socket.sentJson()).toEqual([{ event: "clear" }]);
  });

  test("an 8 kHz agent pays nothing for conversion it does not need", () => {
    const fixture = setup();
    fixture.bridge.send(configFrame(TELEPHONY_SAMPLE_RATE, TELEPHONY_SAMPLE_RATE));
    fixture.socket.msg(JSON.stringify({ event: "start", streamSid: "MZ0", start: {} }));
    fixture.socket.sent.length = 0;

    const pcm = Int16Array.from({ length: 160 }, (_, i) => (i % 2 === 0 ? 4000 : -4000));
    fixture.bridge.send(new Uint8Array(pcm.buffer));

    const [frame] = fixture.socket.sentJson();
    const payload = (frame as { media: { payload: string } }).media.payload;
    const decoded = mulawToPcm16(new Uint8Array(Buffer.from(payload, "base64")));
    expect(decoded).toHaveLength(160);
    // Straight through μ-law only: quantization, and no filter ringing.
    expect(Math.abs((decoded[0] as number) - 4000)).toBeLessThan(150);
  });
});

describe("startTelephonySession", () => {
  test("starts the session on the runtime, tagged as a phone call", () => {
    const socket = new MockWebSocket("ws://carrier.test/phone");
    socket.open();
    const startSession = vi.fn();
    const runtime: SessionRuntime = { startSession, shutdown: () => Promise.resolve() };

    startTelephonySession(socket, runtime, { carrier: twilioCodec, logger: makeLogger() });

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession.mock.calls[0]?.[1]).toEqual({
      logContext: { transport: "phone", carrier: "twilio" },
    });
  });
});
