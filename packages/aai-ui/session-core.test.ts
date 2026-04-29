// Copyright 2025 the AAI authors. MIT license.

import { createSessionCore, type SessionCore } from "./session-core.ts";

let lastSocket: MockWebSocket | null = null;

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = "arraybuffer";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
  url: string;
  _listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(url: string) {
    this.url = url;
    lastSocket = this;
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void, opts?: unknown) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type)?.add(listener);
    const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
    signal?.addEventListener("abort", () => {
      this._listeners.get(type)?.delete(listener);
    });
  }

  removeEventListener(type: string, listener: (...args: unknown[]) => void) {
    this._listeners.get(type)?.delete(listener);
  }

  simulateOpen() {
    this.readyState = 1;
    for (const cb of this._listeners.get("open") ?? []) cb();
  }

  simulateMessage(data: string | Uint8Array | ArrayBuffer) {
    const payload = data instanceof Uint8Array ? data.buffer : data;
    for (const cb of this._listeners.get("message") ?? []) cb({ data: payload });
  }

  simulateClose(code = 1000) {
    this.readyState = 3;
    for (const cb of this._listeners.get("close") ?? []) cb({ code, reason: "" });
  }
}

type ConstructorType = import("./types.ts").WebSocketConstructor;

function makeConfig(sampleRate = 16_000, ttsSampleRate = 24_000, sessionId = "sess-123"): string {
  return JSON.stringify({
    type: "config",
    audioFormat: "pcm16",
    sampleRate,
    ttsSampleRate,
    sessionId,
  });
}

function send(data: string | Uint8Array | ArrayBuffer) {
  lastSocket?.simulateMessage(data);
}

function sendJson(obj: unknown) {
  lastSocket?.simulateMessage(JSON.stringify(obj));
}

describe("createSessionCore", () => {
  let core: SessionCore;

  beforeEach(() => {
    lastSocket = null;
    core = createSessionCore({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocket as unknown as ConstructorType,
    });
  });

  afterEach(() => {
    core.disconnect();
  });

  it("starts in disconnected state", () => {
    const snap = core.getSnapshot();
    expect(snap.state).toBe("disconnected");
    expect(snap.messages).toEqual([]);
    expect(snap.toolCalls).toEqual([]);
    expect(snap.started).toBe(false);
    expect(snap.running).toBe(false);
  });

  it("notifies subscribers on state change", () => {
    const cb = vi.fn();
    core.subscribe(cb);
    core.start();
    expect(cb).toHaveBeenCalled();
    expect(core.getSnapshot().started).toBe(true);
  });

  it("subscribe returns unsubscribe function", () => {
    const cb = vi.fn();
    const unsub = core.subscribe(cb);
    unsub();
    core.start();
    expect(cb).not.toHaveBeenCalled();
  });

  it("getSnapshot returns new reference after update", () => {
    const snap1 = core.getSnapshot();
    core.start();
    const snap2 = core.getSnapshot();
    expect(snap1).not.toBe(snap2);
    expect(snap1.started).toBe(false);
    expect(snap2.started).toBe(true);
  });

  it("connect transitions to connecting state", () => {
    core.connect();
    expect(core.getSnapshot().state).toBe("connecting");
  });

  it("connect transitions to ready on WebSocket open", () => {
    core.connect();
    lastSocket?.simulateOpen();
    expect(core.getSnapshot().state).toBe("ready");
  });

  it("disconnect sets state to disconnected without error", () => {
    core.connect();
    lastSocket?.simulateOpen();
    core.disconnect();
    const snap = core.getSnapshot();
    expect(snap.state).toBe("disconnected");
    expect(snap.error).toBe(null);
    expect(snap.running).toBe(false);
  });

  it("server-initiated close sets disconnected", () => {
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateClose();
    expect(core.getSnapshot().state).toBe("disconnected");
    expect(core.getSnapshot().running).toBe(false);
  });

  it("start sets started and running then connects", () => {
    core.start();
    const snap = core.getSnapshot();
    expect(snap.started).toBe(true);
    expect(snap.running).toBe(true);
    expect(snap.state).toBe("connecting");
  });

  it("external AbortSignal triggers disconnect", () => {
    const controller = new AbortController();
    core.connect({ signal: controller.signal });
    lastSocket?.simulateOpen();
    expect(core.getSnapshot().state).toBe("ready");

    controller.abort();
    expect(core.getSnapshot().state).toBe("disconnected");
  });

  it("Symbol.dispose calls disconnect", () => {
    core.connect();
    lastSocket?.simulateOpen();
    core[Symbol.dispose]();
    expect(core.getSnapshot().state).toBe("disconnected");
  });

  it("toggle connects when disconnected, disconnects when running", () => {
    core.start();
    lastSocket?.simulateOpen();
    expect(core.getSnapshot().running).toBe(true);

    core.toggle();
    expect(core.getSnapshot().running).toBe(false);
    expect(core.getSnapshot().state).toBe("disconnected");

    core.toggle();
    expect(core.getSnapshot().running).toBe(true);
    expect(core.getSnapshot().state).toBe("connecting");
  });

  it("resetState clears messages, toolCalls, transcripts, and error", () => {
    core.connect();
    lastSocket?.simulateOpen();
    core.resetState();
    const snap = core.getSnapshot();
    expect(snap.messages).toEqual([]);
    expect(snap.toolCalls).toEqual([]);
    expect(snap.userTranscript).toBe(null);
    expect(snap.agentTranscript).toBe(null);
    expect(snap.error).toBe(null);
  });

  describe("handleEvent", () => {
    beforeEach(() => {
      core.connect();
      lastSocket?.simulateOpen();
    });

    it("speech_started sets userTranscript to empty string", () => {
      sendJson({ type: "speech_started" });
      expect(core.getSnapshot().userTranscript).toBe("");
    });

    it("speech_stopped is handled without error", () => {
      sendJson({ type: "speech_stopped" });
      expect(core.getSnapshot().state).toBe("ready");
    });

    it("user_transcript appends user message and sets state to thinking", () => {
      sendJson({ type: "user_transcript", text: "Hello world" });
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([{ role: "user", content: "Hello world" }]);
      expect(snap.userTranscript).toBe(null);
      expect(snap.state).toBe("thinking");
    });

    it("agent_transcript appends assistant message", () => {
      sendJson({ type: "agent_transcript", text: "Hi there" });
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([{ role: "assistant", content: "Hi there" }]);
      expect(snap.agentTranscript).toBe(null);
    });

    it("tool_call adds pending tool call", () => {
      sendJson({
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "search",
        args: { query: "test" },
      });
      const snap = core.getSnapshot();
      expect(snap.toolCalls).toHaveLength(1);
      expect(snap.toolCalls[0]).toMatchObject({
        callId: "tc-1",
        name: "search",
        args: { query: "test" },
        status: "pending",
      });
    });

    it("tool_call_done updates matching tool call to done", () => {
      sendJson({
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "search",
        args: { query: "test" },
      });
      sendJson({ type: "tool_call_done", toolCallId: "tc-1", result: "found it" });
      const snap = core.getSnapshot();
      expect(snap.toolCalls).toHaveLength(1);
      expect(snap.toolCalls[0]).toMatchObject({
        callId: "tc-1",
        status: "done",
        result: "found it",
      });
    });

    it("tool_call_done ignores unknown toolCallId", () => {
      sendJson({ type: "tool_call_done", toolCallId: "unknown-id", result: "result" });
      expect(core.getSnapshot().toolCalls).toEqual([]);
    });

    it("reply_done transitions state to listening", () => {
      sendJson({ type: "reply_done" });
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("cancelled resets transcripts and transitions to listening", () => {
      sendJson({ type: "speech_started" });
      expect(core.getSnapshot().userTranscript).toBe("");

      sendJson({ type: "cancelled" });
      const snap = core.getSnapshot();
      expect(snap.userTranscript).toBe(null);
      expect(snap.agentTranscript).toBe(null);
      expect(snap.state).toBe("listening");
    });

    it("reset clears all state and transitions to listening", () => {
      sendJson({ type: "user_transcript", text: "msg1" });
      sendJson({ type: "tool_call", toolCallId: "tc-1", toolName: "t", args: {} });
      expect(core.getSnapshot().messages).toHaveLength(1);

      sendJson({ type: "reset" });
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([]);
      expect(snap.toolCalls).toEqual([]);
      expect(snap.userTranscript).toBe(null);
      expect(snap.agentTranscript).toBe(null);
      expect(snap.error).toBe(null);
      expect(snap.state).toBe("listening");
    });

    it("error event sets error state and stops running", () => {
      sendJson({ type: "error", code: "internal", message: "Something broke" });
      const snap = core.getSnapshot();
      expect(snap.state).toBe("error");
      expect(snap.error).toEqual({ code: "internal", message: "Something broke" });
      expect(snap.running).toBe(false);
    });

    it("non-error event clears error state", () => {
      sendJson({ type: "error", code: "internal", message: "fail" });
      expect(core.getSnapshot().state).toBe("error");

      sendJson({ type: "speech_started" });
      const snap = core.getSnapshot();
      expect(snap.state).not.toBe("error");
      expect(snap.error).toBe(null);
    });
  });

  describe("binary audio handling", () => {
    beforeEach(() => {
      core.connect();
      lastSocket?.simulateOpen();
    });

    it("audio chunk (raw binary) transitions state to speaking", () => {
      send(new Uint8Array(320).buffer);
      expect(core.getSnapshot().state).toBe("speaking");
    });

    it("subsequent audio chunks stay in speaking state", () => {
      send(new Uint8Array(320).buffer);
      send(new Uint8Array(320).buffer);
      expect(core.getSnapshot().state).toBe("speaking");
    });

    it("audio_done transitions back to listening", () => {
      send(new Uint8Array(320).buffer);
      expect(core.getSnapshot().state).toBe("speaking");

      sendJson({ type: "audio_done" });
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("audio chunk ignored in error state with error set", () => {
      sendJson({ type: "error", code: "internal", message: "fail" });
      expect(core.getSnapshot().state).toBe("error");

      send(new Uint8Array(320).buffer);
      expect(core.getSnapshot().error).not.toBe(null);
    });
  });

  describe("message parsing", () => {
    beforeEach(() => {
      core.connect();
      lastSocket?.simulateOpen();
    });

    it("invalid JSON is logged and dropped", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
      send("not valid json {{{");
      expect(warnSpy).toHaveBeenCalledWith("session-core: invalid JSON; dropping");
      expect(core.getSnapshot().state).toBe("ready");
      warnSpy.mockRestore();
    });

    it("unknown server message type is silently dropped", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
      sendJson({ type: "totally_unknown_type_xyz" });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(core.getSnapshot().state).toBe("ready");
      warnSpy.mockRestore();
    });

    it("non-string non-binary frame is dropped with a console warning", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
      // Bypass simulateMessage's typed signature to dispatch a numeric frame.
      for (const cb of lastSocket?._listeners.get("message") ?? []) {
        cb({ data: 42 });
      }
      expect(warnSpy).toHaveBeenCalledWith(
        "session-core: non-string, non-binary frame received; dropping",
      );
      expect(core.getSnapshot().state).toBe("ready");
      warnSpy.mockRestore();
    });
  });

  describe("config message", () => {
    it("calls onSessionId when config includes sessionId", () => {
      const onSessionId = vi.fn();
      core = createSessionCore({
        platformUrl: "ws://localhost:3000",
        WebSocket: MockWebSocket as unknown as ConstructorType,
        onSessionId,
      });
      core.connect();
      lastSocket?.simulateOpen();

      send(makeConfig(16_000, 24_000, "sess-123"));
      expect(onSessionId).toHaveBeenCalledWith("sess-123");
    });

    it("handles config with empty sessionId (no onSessionId call expected)", () => {
      const onSessionId = vi.fn();
      core = createSessionCore({
        platformUrl: "ws://localhost:3000",
        WebSocket: MockWebSocket as unknown as ConstructorType,
        onSessionId,
      });
      core.connect();
      lastSocket?.simulateOpen();

      send(makeConfig(16_000, 24_000, ""));
      expect(onSessionId).not.toHaveBeenCalled();
    });
  });

  describe("send and cancel", () => {
    it("cancel sends JSON cancel message when connected", () => {
      core.connect();
      lastSocket?.simulateOpen();
      core.cancel();
      expect(lastSocket?.send).toHaveBeenCalledTimes(1);
      const sent = lastSocket?.send.mock.calls[0]?.[0];
      expect(typeof sent).toBe("string");
      expect(JSON.parse(sent as string).type).toBe("cancel");
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("cancel does not throw when disconnected", () => {
      expect(() => core.cancel()).not.toThrow();
    });
  });

  describe("reset", () => {
    it("sends JSON reset message when WebSocket is open", () => {
      core.connect();
      lastSocket?.simulateOpen();
      core.reset();
      expect(lastSocket?.send).toHaveBeenCalledTimes(1);
      const sent = lastSocket?.send.mock.calls[0]?.[0];
      expect(typeof sent).toBe("string");
      expect(JSON.parse(sent as string).type).toBe("reset");
    });

    it("disconnects and reconnects when WebSocket is not open", () => {
      core.connect();
      core.reset();
      expect(core.getSnapshot().state).toBe("connecting");
    });
  });

  describe("URL building", () => {
    it("converts http to ws protocol", () => {
      core = createSessionCore({
        platformUrl: "http://localhost:3000",
        WebSocket: MockWebSocket as unknown as ConstructorType,
      });
      core.connect();
      expect(lastSocket?.url).toMatch(/^ws:/);
    });

    it("converts https to wss protocol", () => {
      core = createSessionCore({
        platformUrl: "https://example.com",
        WebSocket: MockWebSocket as unknown as ConstructorType,
      });
      core.connect();
      expect(lastSocket?.url).toMatch(/^wss:/);
    });

    it("uses resumeSessionId on first connect", () => {
      core = createSessionCore({
        platformUrl: "ws://localhost:3000",
        WebSocket: MockWebSocket as unknown as ConstructorType,
        resumeSessionId: "prev-session",
      });
      core.connect();
      expect(lastSocket?.url).toContain("sessionId=prev-session");
    });

    it("adds resume=1 on reconnect (not first connect)", () => {
      core.connect();
      lastSocket?.simulateOpen();
      send(makeConfig());
      core.disconnect();
      core.connect();
      expect(lastSocket?.url).toContain("resume=1");
    });

    it("first connect has no resume param", () => {
      core.connect();
      expect(lastSocket?.url).not.toContain("resume");
      expect(lastSocket?.url).not.toContain("sessionId");
    });
  });

  describe("reconnection", () => {
    it("sends JSON history message on reconnect if messages exist", () => {
      core.connect();
      lastSocket?.simulateOpen();
      send(makeConfig());

      sendJson({ type: "user_transcript", text: "Hello" });
      expect(core.getSnapshot().messages).toHaveLength(1);

      core.disconnect();
      core.connect();
      const reconnectSocket = lastSocket;
      reconnectSocket?.simulateOpen();
      reconnectSocket?.simulateMessage(makeConfig());

      const calls = reconnectSocket?.send.mock.calls ?? [];
      const historyCall = calls.find((c) => {
        if (typeof c[0] !== "string") return false;
        try {
          return JSON.parse(c[0] as string).type === "history";
        } catch {
          return false;
        }
      });
      expect(historyCall).toBeDefined();
      const msg = JSON.parse(historyCall?.[0] as string);
      expect(msg.type).toBe("history");
      expect(msg.messages).toEqual([{ role: "user", content: "Hello" }]);
    });
  });

  describe("rapid reconnect (generation counter)", () => {
    it("ignores events from a stale connection after reconnect", () => {
      core.connect();
      const firstSocket = lastSocket;
      firstSocket?.simulateOpen();

      core.connect();
      const secondSocket = lastSocket;
      expect(secondSocket).not.toBe(firstSocket);

      secondSocket?.simulateOpen();
      secondSocket?.simulateMessage(JSON.stringify({ type: "speech_started" }));
      expect(core.getSnapshot().userTranscript).toBe("");
    });
  });

  describe("conversation flow", () => {
    beforeEach(() => {
      core.connect();
      lastSocket?.simulateOpen();
    });

    it("handles a full turn: speech → transcript → thinking → speaking → listening", () => {
      sendJson({ type: "speech_started" });
      expect(core.getSnapshot().userTranscript).toBe("");

      sendJson({ type: "speech_stopped" });

      sendJson({ type: "user_transcript", text: "What time is it?" });
      expect(core.getSnapshot().state).toBe("thinking");
      expect(core.getSnapshot().messages).toHaveLength(1);

      sendJson({ type: "agent_transcript", text: "It is 3pm." });
      expect(core.getSnapshot().messages).toHaveLength(2);

      send(new Uint8Array(320).buffer);
      expect(core.getSnapshot().state).toBe("speaking");

      sendJson({ type: "audio_done" });
      expect(core.getSnapshot().state).toBe("listening");

      sendJson({ type: "reply_done" });
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("handles a turn with tool calls", () => {
      sendJson({ type: "user_transcript", text: "Search for cats" });

      sendJson({
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "web_search",
        args: { query: "cats" },
      });
      expect(core.getSnapshot().toolCalls).toHaveLength(1);
      expect(core.getSnapshot().toolCalls[0]?.status).toBe("pending");

      sendJson({ type: "tool_call_done", toolCallId: "tc-1", result: "Found 42 cats" });
      expect(core.getSnapshot().toolCalls[0]?.status).toBe("done");
      expect(core.getSnapshot().toolCalls[0]?.result).toBe("Found 42 cats");

      sendJson({ type: "agent_transcript", text: "I found 42 cats." });
      expect(core.getSnapshot().messages).toHaveLength(2);
    });

    it("tool call afterMessageIndex tracks insertion point", () => {
      sendJson({ type: "user_transcript", text: "msg1" });
      sendJson({ type: "agent_transcript", text: "reply1" });
      sendJson({ type: "user_transcript", text: "msg2" });
      expect(core.getSnapshot().messages).toHaveLength(3);

      sendJson({ type: "tool_call", toolCallId: "tc-1", toolName: "calc", args: {} });
      expect(core.getSnapshot().toolCalls[0]?.afterMessageIndex).toBe(2);
    });
  });
});
