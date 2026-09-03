// Copyright 2026 the AAI authors. MIT license.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import { flush, silentLogger } from "../_test-utils.ts";
import { makeCallbacks as noopCallbacks } from "./_transport-recorder.ts";
import {
  createOpenaiRealtimeTransport,
  type OpenaiRealtimeWebSocket,
} from "./openai-realtime-transport.ts";

type Listener = (ev: unknown) => void;

function makeFakeWs() {
  const listeners: Record<string, Listener[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  const sent: string[] = [];
  const ws: OpenaiRealtimeWebSocket = {
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
    close() {
      for (const fn of listeners.close ?? []) fn({ code: 1000, reason: "" });
    },
    addEventListener(type: string, fn: Listener) {
      (listeners[type] ?? []).push(fn);
    },
  } as OpenaiRealtimeWebSocket;
  return Object.assign(ws, {
    fire(type: "open" | "message" | "close" | "error", ev?: unknown) {
      for (const fn of listeners[type] ?? []) fn(ev);
    },
    sent,
  });
}

function startedTransport() {
  const fake = makeFakeWs();
  const cbs = noopCallbacks();
  const transport = createOpenaiRealtimeTransport({
    apiKey: "sk",
    options: {},
    sessionConfig: { systemPrompt: "" },
    toolSchemas: [],
    toolChoice: "auto",
    callbacks: cbs,
    sid: "s",
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
    createWebSocket: () => fake,
    logger: silentLogger,
  });
  const ready = transport.start();
  fake.fire("open");
  return { fake, cbs, transport, ready };
}

describe("openai-realtime-transport: connect and session.update", () => {
  test("a close before the open rejects start() instead of hanging", async () => {
    // Regression guard: this transport used to reject the connect only on
    // `error`. A socket that closed without erroring (an auth rejection that
    // closes the connection) left start() awaiting a promise that could never
    // settle. The shared createWsOpenRace owns that rule for both transports.
    const fake = makeFakeWs();
    const transport = createOpenaiRealtimeTransport({
      apiKey: "sk",
      options: {},
      sessionConfig: { systemPrompt: "" },
      toolSchemas: [],
      toolChoice: "auto",
      callbacks: noopCallbacks(),
      sid: "s",
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
      createWebSocket: () => fake,
      logger: silentLogger,
    });
    const started = transport.start();
    fake.fire("close", { code: 4001, reason: "unauthorized" });
    await expect(started).rejects.toThrow(/closed before open \(code: 4001\)/);
  });

  test("a close after the open does not affect the settled connect", async () => {
    const { ready, fake, cbs } = startedTransport();
    await expect(ready).resolves.toBeUndefined();
    fake.fire("close", { code: 1006, reason: "" });
    // Routed to the session, not the (already settled) connect.
    expect(cbs.reported("error.reported")).toHaveBeenCalled();
  });

  test("opens WS with auth headers and sends session.update on open", async () => {
    const fake = makeFakeWs();
    const createWs = vi.fn(() => fake);

    const transport = createOpenaiRealtimeTransport({
      apiKey: "sk-test",
      options: { model: "gpt-realtime", voice: "cedar" },
      sessionConfig: {
        systemPrompt: "Be terse.",
      },
      toolSchemas: [
        {
          type: "function",
          name: "lookup",
          description: "look up something",
          parameters: { type: "object", properties: {} },
        },
      ],
      toolChoice: "auto",
      callbacks: noopCallbacks(),
      sid: "sid-1",
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
      createWebSocket: createWs,
      logger: silentLogger,
    });

    const startP = transport.start();
    fake.fire("open");
    await startP;

    expect(createWs).toHaveBeenCalledWith(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-test" },
      }),
    );

    expect(fake.sent.length).toBe(1);
    const first = fake.sent[0];
    if (first === undefined) throw new Error("expected one send");
    const msg = JSON.parse(first);
    expect(msg.type).toBe("session.update");
    expect(msg.session.type).toBe("realtime");
    expect(msg.session.output_modalities).toEqual(["audio"]);
    expect(msg.session.instructions).toBe("Be terse.");
    expect(msg.session.audio.input.format).toEqual({ type: "audio/pcm", rate: 16_000 });
    expect(msg.session.audio.input.turn_detection.type).toBe("server_vad");
    expect(msg.session.audio.input.transcription).toEqual({ model: "whisper-1" });
    expect(msg.session.audio.output.format).toEqual({ type: "audio/pcm", rate: 24_000 });
    expect(msg.session.audio.output.voice).toBe("cedar");
    expect(msg.session.tools).toEqual([
      expect.objectContaining({ type: "function", name: "lookup" }),
    ]);
    expect(msg.session.tool_choice).toBe("auto");
  });
});

describe("greeting", () => {
  function makeWithGreeting(args: { greeting?: string; skipGreeting?: boolean }) {
    const fake = makeFakeWs();
    const transport = createOpenaiRealtimeTransport({
      apiKey: "sk",
      options: {},
      sessionConfig: {
        systemPrompt: "",
        ...omitUndefined({ greeting: args.greeting }),
      },
      toolSchemas: [],
      toolChoice: "auto",
      callbacks: noopCallbacks(),
      sid: "s",
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
      ...omitUndefined({ skipGreeting: args.skipGreeting }),
      createWebSocket: () => fake,
      logger: silentLogger,
    });
    const ready = transport.start();
    fake.fire("open");
    return { fake, ready };
  }

  test("sends response.create with quoted greeting after session.update", async () => {
    const { fake, ready } = makeWithGreeting({ greeting: 'Hello, "friend".' });
    await ready;
    expect(fake.sent.length).toBe(2);
    expect(JSON.parse(fake.sent[0] ?? "{}").type).toBe("session.update");
    const greetingMsg = JSON.parse(fake.sent[1] ?? "{}");
    expect(greetingMsg.type).toBe("response.create");
    // JSON.stringify quotes the greeting and escapes any embedded quotes —
    // protects against prompt-injection by closing the instruction string.
    expect(greetingMsg.response.instructions).toBe('Say exactly: "Hello, \\"friend\\"."');
  });

  test("no greeting send when greeting is undefined", async () => {
    const { fake, ready } = makeWithGreeting({});
    await ready;
    expect(fake.sent.length).toBe(1);
    expect(JSON.parse(fake.sent[0] ?? "{}").type).toBe("session.update");
  });

  test("skipGreeting suppresses the greeting send", async () => {
    const { fake, ready } = makeWithGreeting({ greeting: "Hi.", skipGreeting: true });
    await ready;
    expect(fake.sent.length).toBe(1);
    expect(JSON.parse(fake.sent[0] ?? "{}").type).toBe("session.update");
  });
});

describe("audio in/out", () => {
  test("sendUserAudio sends input_audio_buffer.append with base64 payload", async () => {
    const { fake, transport, ready } = startedTransport();
    await ready;
    fake.sent.length = 0;
    transport.sendUserAudio(new Uint8Array([1, 2, 3, 4]));
    expect(fake.sent.length).toBe(1);
    const first = fake.sent[0];
    if (first === undefined) throw new Error("expected one send");
    const msg = JSON.parse(first);
    expect(msg.type).toBe("input_audio_buffer.append");
    expect(typeof msg.audio).toBe("string");
    expect(Buffer.from(msg.audio, "base64")).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  test("sendUserAudio drops frames while the socket buffer exceeds the cap, then resumes", async () => {
    const { fake, transport, ready } = startedTransport();
    await ready;
    fake.sent.length = 0;

    Object.assign(fake, { bufferedAmount: 8 * 1024 * 1024 });
    transport.sendUserAudio(new Uint8Array([1, 2, 3, 4]));
    expect(fake.sent.length).toBe(0);

    Object.assign(fake, { bufferedAmount: 0 });
    transport.sendUserAudio(new Uint8Array([1, 2, 3, 4]));
    expect(fake.sent.length).toBe(1);
  });

  test("response.output_audio.delta calls onAudioChunk with decoded bytes", async () => {
    const type = "response.output_audio.delta";
    const { fake, cbs, ready } = startedTransport();
    await ready;
    const audio = Buffer.from([5, 6, 7, 8]).toString("base64");
    fake.fire("message", { data: JSON.stringify({ type, delta: audio }) });
    expect(cbs.onAudioChunk).toHaveBeenCalledTimes(1);
    expect(cbs.onAudioChunk).toHaveBeenCalledWith(new Uint8Array([5, 6, 7, 8]));
  });

  test("response.output_audio.done reports audio.completed", async () => {
    const type = "response.output_audio.done";
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", { data: JSON.stringify({ type }) });
    expect(cbs.reported("audio.completed")).toHaveBeenCalledTimes(1);
  });
});

describe("VAD, user transcript, reply lifecycle, agent transcript", () => {
  test("speech_started/stopped routed to callbacks", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
    });
    fake.fire("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_stopped" }),
    });
    expect(cbs.reported("speech.started")).toHaveBeenCalledTimes(1);
    expect(cbs.reported("speech.stopped")).toHaveBeenCalledTimes(1);
  });

  test("user transcription completed routes to a committed user transcript", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello world",
      }),
    });
    expect(cbs.reported("user-transcript.committed")).toHaveBeenCalledWith({
      type: "user-transcript.committed",
      text: "hello world",
    });
  });

  test("response.created → onReplyStarted; response.done → onReplyDone", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "resp_1" } }),
    });
    expect(cbs.onReplyStarted).toHaveBeenCalledWith("resp_1");
    fake.fire("message", { data: JSON.stringify({ type: "response.done" }) });
    expect(cbs.reported("reply.completed")).toHaveBeenCalledTimes(1);
  });

  test("agent transcript: deltas accumulated, emitted on done", async () => {
    const prefix = "response.output_audio_transcript";
    const { fake, cbs, ready } = startedTransport();
    await ready;
    const item_id = "item_x";
    fake.fire("message", {
      data: JSON.stringify({ type: `${prefix}.delta`, item_id, delta: "Hi " }),
    });
    fake.fire("message", {
      data: JSON.stringify({ type: `${prefix}.delta`, item_id, delta: "there." }),
    });
    expect(cbs.reported("agent-transcript.committed")).not.toHaveBeenCalled();
    fake.fire("message", {
      data: JSON.stringify({ type: `${prefix}.done`, item_id }),
    });
    expect(cbs.reported("agent-transcript.committed")).toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: "Hi there.",
    });
  });

  test("agent transcript: done with no buffered deltas does not emit", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.output_audio_transcript.done",
        item_id: "empty",
      }),
    });
    expect(cbs.reported("agent-transcript.committed")).not.toHaveBeenCalled();
  });
});

describe("tool calls", () => {
  test("function_call_arguments deltas accumulate; .done reports tool.called", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    const item_id = "item_t";
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.output_item.added",
        item: { id: item_id, type: "function_call", name: "lookup", call_id: "call_1" },
      }),
    });
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id,
        delta: '{"q":',
      }),
    });
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id,
        delta: '"hi"}',
      }),
    });
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id,
        call_id: "call_1",
        name: "lookup",
        arguments: '{"q":"hi"}',
      }),
    });
    expect(cbs.reported("tool.called")).toHaveBeenCalledWith({
      type: "tool.called",
      toolCallId: "call_1",
      toolName: "lookup",
      args: { q: "hi" },
    });
  });

  test("done with empty/invalid args still calls onToolCall with {}", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    const item_id = "item_e";
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.output_item.added",
        item: { id: item_id, type: "function_call", name: "noop", call_id: "call_e" },
      }),
    });
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        item_id,
        call_id: "call_e",
        name: "noop",
        arguments: "",
      }),
    });
    expect(cbs.reported("tool.called")).toHaveBeenCalledWith({
      type: "tool.called",
      toolCallId: "call_e",
      toolName: "noop",
      args: {},
    });
  });

  test("sendToolResult sends conversation.item.create + response.create", async () => {
    const { fake, transport, ready } = startedTransport();
    await ready;
    fake.sent.length = 0; // drop session.update
    transport.sendToolResult("call_1", '{"ok":true}');
    // function_call_output is sent immediately; response.create is queued.
    expect(fake.sent.length).toBe(1);
    const m1 = JSON.parse(fake.sent[0] ?? "{}");
    expect(m1.type).toBe("conversation.item.create");
    expect(m1.item.type).toBe("function_call_output");
    expect(m1.item.call_id).toBe("call_1");
    expect(m1.item.output).toBe('{"ok":true}');
    await flush();
    expect(fake.sent.length).toBe(2);
    const m2 = JSON.parse(fake.sent[1] ?? "{}");
    expect(m2.type).toBe("response.create");
  });

  test("multiple sendToolResult calls coalesce into a single response.create", async () => {
    const { fake, transport, ready } = startedTransport();
    await ready;
    fake.sent.length = 0;
    // Synchronous burst — session-core flushes pending tool results in a loop.
    transport.sendToolResult("call_1", '{"a":1}');
    transport.sendToolResult("call_2", '{"b":2}');
    transport.sendToolResult("call_3", '{"c":3}');
    // Three function_call_outputs sent immediately, no response.create yet.
    expect(fake.sent.length).toBe(3);
    expect(fake.sent.every((s) => JSON.parse(s).type === "conversation.item.create")).toBe(true);
    await flush();
    // After the microtask, exactly one response.create — second one would be
    // rejected as `conversation_already_has_active_response`.
    expect(fake.sent.length).toBe(4);
    expect(JSON.parse(fake.sent[3] ?? "{}").type).toBe("response.create");
  });
});

describe("cancel, error, close", () => {
  test("cancelReply sends response.cancel only when a reply is in flight", async () => {
    const { fake, transport, ready } = startedTransport();
    await ready;
    fake.sent.length = 0;
    // No reply yet — cancel should be a no-op
    transport.cancelReply();
    expect(fake.sent.length).toBe(0);

    fake.fire("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "r1" } }),
    });
    transport.cancelReply();
    expect(fake.sent.length).toBe(1);
    expect(JSON.parse(fake.sent[0] ?? "{}").type).toBe("response.cancel");
  });

  test("cancelReply does not fire onCancelled (session-core emits `cancelled` itself)", async () => {
    const { fake, cbs, transport, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "r2" } }),
    });
    transport.cancelReply();
    expect(cbs.reported("reply.cancelled")).not.toHaveBeenCalled();
  });

  test("server-VAD barge-in flushes client playback via onCancelled", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "r3" } }),
    });
    // OpenAI cancels the response server-side on speech_started; unlike a
    // client cancelReply, nothing else tells the client to flush its buffered
    // audio, so the transport must emit onCancelled itself.
    fake.fire("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
    });
    expect(cbs.reported("reply.cancelled")).toHaveBeenCalledTimes(1);
    expect(cbs.reported("speech.started")).toHaveBeenCalledTimes(1);
  });

  test("speech_started with no reply in flight does not fire onCancelled", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
    });
    expect(cbs.reported("reply.cancelled")).not.toHaveBeenCalled();
    expect(cbs.reported("speech.started")).toHaveBeenCalledTimes(1);
  });

  // NON-fatal is the load-bearing half of these two. An in-band `error` event
  // leaves the socket open and the session usable, while a fatal frame makes
  // aai-ui release the microphone and end the call — so reporting one as fatal
  // cost the user their mic for a complaint the session survived. Session death
  // is handleClose's to report, with the close code attached.
  test("error event routes to onError with internal code, non-fatally", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "error", error: { message: "boom" } }),
    });
    expect(cbs.reported("error.reported")).toHaveBeenCalledWith({
      type: "error.reported",
      code: "internal",
      message: "boom",
      fatal: false,
    });
  });

  test("an in-band error does not discard the live reply's transcript", async () => {
    // The other half of "the socket stays open and the session is usable": the
    // response the error interrupted is STILL RUNNING, so its transcript buffer
    // is live state. Clearing it made the later `…transcript.done` read "" and
    // suppress the emit — the caller heard the whole reply, the client showed
    // no transcript, and nothing entered history.
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "r4" } }),
    });
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.output_audio_transcript.delta",
        item_id: "i1",
        delta: "Your balance is",
      }),
    });
    fake.fire("message", {
      data: JSON.stringify({ type: "error", error: { message: "unknown field" } }),
    });
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.output_audio_transcript.delta",
        item_id: "i1",
        delta: " five hundred dollars.",
      }),
    });
    fake.fire("message", {
      data: JSON.stringify({ type: "response.output_audio_transcript.done", item_id: "i1" }),
    });
    expect(cbs.reported("agent-transcript.committed")).toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: "Your balance is five hundred dollars.",
    });
  });

  test("a response that really ended does discard them", async () => {
    // The counterpart: `response.done` is a real end, so the next reply must
    // not inherit this one's buffer.
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", {
      data: JSON.stringify({ type: "response.created", response: { id: "r5" } }),
    });
    fake.fire("message", {
      data: JSON.stringify({
        type: "response.output_audio_transcript.delta",
        item_id: "i2",
        delta: "half a sentence",
      }),
    });
    fake.fire("message", { data: JSON.stringify({ type: "response.done" }) });
    fake.fire("message", {
      data: JSON.stringify({ type: "response.output_audio_transcript.done", item_id: "i2" }),
    });
    expect(cbs.reported("agent-transcript.committed")).not.toHaveBeenCalled();
  });

  test("error event with missing message uses fallback", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("message", { data: JSON.stringify({ type: "error" }) });
    // The exact string, not `expect.any(String)`: this is the only text a
    // client operator sees for a message-less service error, and `""` or
    // `"[object Object]"` would satisfy the loose matcher.
    expect(cbs.reported("error.reported")).toHaveBeenCalledWith({
      type: "error.reported",
      code: "internal",
      message: "OpenAI Realtime error",
      fatal: false,
    });
  });

  test("unexpected close routes to onError with connection code", async () => {
    const { fake, cbs, ready } = startedTransport();
    await ready;
    fake.fire("close", { code: 1006, reason: "" });
    expect(cbs.reported("error.reported")).toHaveBeenCalledWith({
      type: "error.reported",
      code: "connection",
      message: expect.stringMatching(/closed/i),
      fatal: true,
    });
  });
});
