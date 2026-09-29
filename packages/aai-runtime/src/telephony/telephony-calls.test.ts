// Copyright 2026 the AAI authors. MIT license.
/**
 * A PLACED call, end to end through a real runtime over fake pipeline
 * providers and a mock carrier socket: the three things an app that dials out
 * through Twilio needs from a `WS /phone` session.
 *
 * - **Identity.** `sessionContext` and `onSessionEnd` see the carrier's call id
 *   and the stream's `<Parameter>`s — which means the session is started only
 *   once the carrier's `start` frame has arrived.
 * - **Refusal.** `sessionContext` answering `refuse` hangs up before the
 *   greeting and before any model call, on a phone and on a browser socket.
 * - **Hanging up.** A tool's `endSession(ctx)` lets the goodbye PLAY and then
 *   closes the carrier's stream, as a normal stop.
 *
 * The pieces have their own specs (`carriers.test.ts`, `session-context.test.ts`,
 * `paced-client-sink.test.ts`, `session-end.test.ts` in the SDK); this one pins
 * the wiring between them.
 */

import { type AgentDef, endSession, type SessionEndContext } from "@alexkroman1/aai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ScriptedPart } from "../_fake-llm.ts";
import { MockWebSocket } from "../_mock-ws.ts";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  type FakeTtsSession,
  registerFakeProviders,
} from "../_pipeline-test-fakes.ts";
import { makeAgent, makeLogger } from "../_test-utils.ts";
import { createRuntimeWithSeams } from "../runtime.ts";
import { twilioCodec } from "./carriers.ts";
import { startTelephonySession } from "./telephony-server.ts";

let unregister: (() => void) | undefined;
afterEach(() => unregister?.());

/** What the carrier socket saw, in order: an outbound media frame, or the close. */
type CarrierLog = ("media" | { close: number | undefined })[];

/** A carrier socket that records its media frames and its close in ONE ordered log. */
function carrierSocket(): { socket: MockWebSocket; log: CarrierLog } {
  const socket = new MockWebSocket("ws://carrier.test/phone?carrier=twilio");
  socket.open();
  const log: CarrierLog = [];
  const send = socket.send.bind(socket);
  socket.send = (data) => {
    if (typeof data === "string" && data.includes('"event":"media"')) log.push("media");
    send(data);
  };
  const close = socket.close.bind(socket);
  socket.close = (code, reason) => {
    log.push({ close: code });
    close(code, reason);
  };
  return { socket, log };
}

/** Twilio's `start` frame for a call the app placed with `<Parameter name="call">`. */
function twilioStart(parameters: Record<string, string> = { call: "c_81f2" }): string {
  return JSON.stringify({
    event: "start",
    streamSid: "MZ0",
    start: {
      callSid: "CA0123456789abcdef",
      customParameters: parameters,
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
    },
  });
}

/**
 * A runtime whose TTS SPEAKS the goodbye: 200 ms of audio when the turn's text
 * says "Goodbye", nothing otherwise — so a media frame on the carrier after the
 * user's turn is the goodbye and nothing else.
 */
function phoneRuntime(agent: Partial<AgentDef>, steps: ScriptedPart[][] = [[]]) {
  const stt = createFakeSttProvider();
  const tts = createFakeTtsProvider({ autoDoneOnFlush: false });
  const open = tts.open.bind(tts);
  tts.open = async (options) => {
    const session = (await open(options)) as FakeTtsSession;
    let spoken = 0;
    session.flush.mockImplementation(() => {
      const text = session.textChunks.slice(spoken).join("");
      spoken = session.textChunks.length;
      if (text.includes("Goodbye")) session.fireAudio(new Int16Array(options.sampleRate / 5));
      session.emitter.emit("done");
    });
    return session;
  };
  const llm = createFakeLanguageModel({ steps });
  const fakes = registerFakeProviders({ stt, tts, llm });
  unregister = fakes.unregister;
  const logger = makeLogger();
  const runtime = createRuntimeWithSeams({
    agent: makeAgent(agent),
    env: fakes.env,
    logger,
    stt: fakes.stt,
    llm: fakes.llm,
    tts: fakes.tts,
  });
  return { runtime, stt, llm, logger };
}

describe("a placed call's identity", () => {
  test("sessionContext and onSessionEnd see the call id and parameters from the start frame", async () => {
    const sessionContext = vi.fn(() => undefined);
    const ended: SessionEndContext[] = [];
    const { runtime } = phoneRuntime({
      sessionContext,
      onSessionEnd: (ctx) => void ended.push(ctx),
    });
    const { socket } = carrierSocket();

    startTelephonySession(socket, runtime, { carrier: twilioCodec, logger: makeLogger() });
    // Nothing is started — and so nothing is asked — before the carrier says
    // which call this is. That is the ordering the wait exists for.
    await Promise.resolve();
    expect(sessionContext).not.toHaveBeenCalled();

    socket.msg(twilioStart());
    const call = {
      carrier: "twilio",
      callId: "CA0123456789abcdef",
      parameters: { call: "c_81f2" },
    };
    await vi.waitFor(() =>
      expect(sessionContext).toHaveBeenCalledWith(expect.objectContaining({ call })),
    );

    socket.disconnect(1000);
    await vi.waitFor(() => expect(ended).toHaveLength(1));
    expect(ended[0]?.call).toEqual(call);
    await runtime.shutdown();
  });
});

describe("sessionContext refusing a session", () => {
  test("a phone call is hung up before the greeting and before any model call", async () => {
    const ended = vi.fn();
    const { runtime, llm, logger } = phoneRuntime({
      greeting: "Goodbye is not what a refused caller hears.",
      sessionContext: ({ call }) =>
        call?.parameters.call === "c_real" ? undefined : { refuse: "not a placed call" },
      onSessionEnd: ended,
    });
    const { socket, log } = carrierSocket();

    startTelephonySession(socket, runtime, { carrier: twilioCodec, logger });
    socket.msg(twilioStart({ call: "c_forged" }));

    // Closing the carrier's stream is what hangs a `<Connect><Stream>` call up.
    await vi.waitFor(() => expect(socket.readyState).toBe(MockWebSocket.CLOSED));
    expect(log).toEqual([{ close: 1008 }]);
    expect(llm.calls).toEqual([]);
    // Once, naming the app's reason — and nothing about who called.
    const refusals = logger.warn.mock.calls.filter(([msg]) => String(msg).includes("refused"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.[1]).toMatchObject({ reason: "not a placed call", carrier: "twilio" });
    expect(JSON.stringify(refusals)).not.toContain("c_forged");
    expect(JSON.stringify(refusals)).not.toContain("CA0123456789abcdef");
    await runtime.shutdown();
    // A refused session never began, so there is nothing for the app to digest.
    expect(ended).not.toHaveBeenCalled();
  });

  test("a WebSocket client is closed with 1008 and the reason, before any model call", async () => {
    const { runtime, llm } = phoneRuntime({
      sessionContext: () => ({ refuse: "unknown device" }),
    });
    const ws = new MockWebSocket("ws://agent.test/websocket");
    ws.open();
    const closes: { code: number | undefined; reason: string | undefined }[] = [];
    ws.close = (code, reason) => {
      closes.push({ code, reason });
      MockWebSocket.prototype.close.call(ws, code, reason);
    };

    runtime.startSession(ws);
    await vi.waitFor(() => expect(closes).toEqual([{ code: 1008, reason: "unknown device" }]));
    // No `error.reported` first: nothing failed, and `fatal` would read as "retry".
    expect(ws.sentJson().map((e) => e.type)).not.toContain("error.reported");
    expect(llm.calls).toEqual([]);
    await runtime.shutdown();
  });
});

describe("endSession from a tool", () => {
  test("the goodbye is spoken before the carrier's stream is closed, and the stop is normal", async () => {
    const ended: SessionEndContext[] = [];
    const { runtime, stt } = phoneRuntime(
      {
        greeting: "",
        tools: {
          end_call: {
            description: "Hang up.",
            execute: (_args, ctx) => ({ ended: endSession(ctx) }),
          },
        },
        onSessionEnd: (ctx) => void ended.push(ctx),
      },
      [
        [{ type: "tool-call", toolCallId: "tc-1", toolName: "end_call", input: "{}" }],
        [{ type: "text", text: "Goodbye, and thanks for calling." }],
      ],
    );
    const { socket, log } = carrierSocket();

    startTelephonySession(socket, runtime, { carrier: twilioCodec, logger: makeLogger() });
    socket.msg(twilioStart());
    await vi.waitFor(() => expect(stt.last()).toBeDefined());
    stt.last()?.fireFinal("That's all, bye.");

    await vi.waitFor(() => expect(socket.readyState).toBe(MockWebSocket.CLOSED), {
      timeout: 4000,
    });
    // Every frame of the goodbye went out, and THEN the line closed — normally.
    expect(log.length).toBeGreaterThan(1);
    expect(log.at(-1)).toEqual({ close: 1000 });
    expect(log.slice(0, -1).every((entry) => entry === "media")).toBe(true);
    await vi.waitFor(() => expect(ended).toHaveLength(1));
    expect(ended[0]?.lastEventIndex).toBeGreaterThan(0);
    await runtime.shutdown();
  });
});
