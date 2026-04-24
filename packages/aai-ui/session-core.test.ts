// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCore, type SessionCore } from "./session-core.ts";

// ─── Mock WebSocket ─────────────────────────────────────────────────────────

/** Track the last created MockWebSocket so tests can simulate server messages. */
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
  private _listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  url: string;
  constructor(url: string) {
    this.url = url;
    lastSocket = this;
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void, opts?: unknown) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type)?.add(listener);
    // Track AbortSignal-based cleanup
    const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
    if (signal) {
      signal.addEventListener("abort", () => {
        this._listeners.get(type)?.delete(listener);
      });
    }
  }

  removeEventListener(type: string, listener: (...args: unknown[]) => void) {
    this._listeners.get(type)?.delete(listener);
  }

  /** Simulate the WebSocket opening. */
  simulateOpen() {
    this.readyState = 1;
    for (const cb of this._listeners.get("open") ?? []) cb();
  }

  /** Simulate receiving a message from the server (text JSON, binary ArrayBuffer, or Uint8Array). */
  simulateMessage(data: string | Uint8Array | ArrayBuffer) {
    const payload = data instanceof Uint8Array ? data.buffer : data;
    for (const cb of this._listeners.get("message") ?? []) {
      cb({ data: payload });
    }
  }

  /** Simulate server-initiated close. */
  simulateClose(code = 1000) {
    this.readyState = 3;
    for (const cb of this._listeners.get("close") ?? []) {
      cb({ code, reason: "" });
    }
  }
}

type ConstructorType = import("./types.ts").WebSocketConstructor;

// ─── Helper to build a config JSON string ───────────────────────────────────

function makeConfig(sampleRate = 16_000, ttsSampleRate = 24_000, sessionId = "sess-123"): string {
  return JSON.stringify({
    type: "config",
    audioFormat: "pcm16",
    sampleRate,
    ttsSampleRate,
    sessionId,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

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

  // ─── Initial state ──────────────────────────────────────────────────────

  it("starts in disconnected state", () => {
    const snap = core.getSnapshot();
    expect(snap.state).toBe("disconnected");
    expect(snap.messages).toEqual([]);
    expect(snap.toolCalls).toEqual([]);
    expect(snap.started).toBe(false);
    expect(snap.running).toBe(false);
  });

  // ─── Subscribe / getSnapshot ────────────────────────────────────────────

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

  // ─── Connection lifecycle ───────────────────────────────────────────────

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
    expect(core.getSnapshot().state).toBe("disconnected");
    expect(core.getSnapshot().error).toBe(null);
    expect(core.getSnapshot().running).toBe(false);
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

  // ─── Toggle ─────────────────────────────────────────────────────────────

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

  // ─── resetState ─────────────────────────────────────────────────────────

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

  // ─── Event handling via simulated server messages ───────────────────────

  describe("handleEvent", () => {
    beforeEach(() => {
      core.connect();
      lastSocket?.simulateOpen();
    });

    it("speech_started sets userTranscript to empty string", () => {
      lastSocket?.simulateMessage(JSON.stringify({ type: "speech_started" }));
      expect(core.getSnapshot().userTranscript).toBe("");
    });

    it("speech_stopped is handled without error", () => {
      lastSocket?.simulateMessage(JSON.stringify({ type: "speech_stopped" }));
      // speech_stopped is a no-op, state shouldn't change
      expect(core.getSnapshot().state).toBe("ready");
    });

    it("user_transcript appends user message and sets state to thinking", () => {
      lastSocket?.simulateMessage(JSON.stringify({ type: "user_transcript", text: "Hello world" }));
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([{ role: "user", content: "Hello world" }]);
      expect(snap.userTranscript).toBe(null);
      expect(snap.state).toBe("thinking");
    });

    it("agent_transcript appends assistant message", () => {
      lastSocket?.simulateMessage(JSON.stringify({ type: "agent_transcript", text: "Hi there" }));
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([{ role: "assistant", content: "Hi there" }]);
      expect(snap.agentTranscript).toBe(null);
    });

    it("tool_call adds pending tool call", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({
          type: "tool_call",
          toolCallId: "tc-1",
          toolName: "search",
          args: { query: "test" },
        }),
      );
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
      // First add a tool call
      lastSocket?.simulateMessage(
        JSON.stringify({
          type: "tool_call",
          toolCallId: "tc-1",
          toolName: "search",
          args: { query: "test" },
        }),
      );
      // Then complete it
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool_call_done", toolCallId: "tc-1", result: "found it" }),
      );
      const snap = core.getSnapshot();
      expect(snap.toolCalls).toHaveLength(1);
      expect(snap.toolCalls[0]).toMatchObject({
        callId: "tc-1",
        status: "done",
        result: "found it",
      });
    });

    it("tool_call_done ignores unknown toolCallId", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool_call_done", toolCallId: "unknown-id", result: "result" }),
      );
      // Should not throw, toolCalls should remain empty
      expect(core.getSnapshot().toolCalls).toEqual([]);
    });

    it("reply_done transitions state to listening", () => {
      lastSocket?.simulateMessage(JSON.stringify({ type: "reply_done" }));
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("cancelled resets transcripts and transitions to listening", () => {
      // Set up some transcript state
      lastSocket?.simulateMessage(JSON.stringify({ type: "speech_started" }));
      expect(core.getSnapshot().userTranscript).toBe("");

      lastSocket?.simulateMessage(JSON.stringify({ type: "cancelled" }));
      const snap = core.getSnapshot();
      expect(snap.userTranscript).toBe(null);
      expect(snap.agentTranscript).toBe(null);
      expect(snap.state).toBe("listening");
    });

    it("reset clears all state and transitions to listening", () => {
      // Accumulate some state
      lastSocket?.simulateMessage(JSON.stringify({ type: "user_transcript", text: "msg1" }));
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool_call", toolCallId: "tc-1", toolName: "t", args: {} }),
      );
      expect(core.getSnapshot().messages).toHaveLength(1);

      lastSocket?.simulateMessage(JSON.stringify({ type: "reset" }));
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([]);
      expect(snap.toolCalls).toEqual([]);
      expect(snap.userTranscript).toBe(null);
      expect(snap.agentTranscript).toBe(null);
      expect(snap.error).toBe(null);
      expect(snap.state).toBe("listening");
    });

    it("error event sets error state and stops running", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "error", code: "internal", message: "Something broke" }),
      );
      const snap = core.getSnapshot();
      expect(snap.state).toBe("error");
      expect(snap.error).toEqual({ code: "internal", message: "Something broke" });
      expect(snap.running).toBe(false);
    });

    it("non-error event clears error state", () => {
      // Set error state
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "error", code: "internal", message: "fail" }),
      );
      expect(core.getSnapshot().state).toBe("error");

      // Any non-error event should clear it
      lastSocket?.simulateMessage(JSON.stringify({ type: "speech_started" }));
      const snap = core.getSnapshot();
      expect(snap.state).not.toBe("error");
      expect(snap.error).toBe(null);
    });
  });

  // ─── Binary audio frames ──────────────────────────────────────────────────

  describe("binary audio handling", () => {
    beforeEach(() => {
      core.connect();
      lastSocket?.simulateOpen();
    });

    it("audio chunk (raw binary) transitions state to speaking", () => {
      const pcm = new Uint8Array(320);
      lastSocket?.simulateMessage(pcm.buffer);
      expect(core.getSnapshot().state).toBe("speaking");
    });

    it("subsequent audio chunks stay in speaking state", () => {
      lastSocket?.simulateMessage(new Uint8Array(320).buffer);
      lastSocket?.simulateMessage(new Uint8Array(320).buffer);
      expect(core.getSnapshot().state).toBe("speaking");
    });

    it("audio_done transitions back to listening", async () => {
      lastSocket?.simulateMessage(new Uint8Array(320).buffer);
      expect(core.getSnapshot().state).toBe("speaking");

      lastSocket?.simulateMessage(JSON.stringify({ type: "audio_done" }));
      // Without voiceIO, the done handler calls updateState directly
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("audio chunk ignored in error state with error set", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "error", code: "internal", message: "fail" }),
      );
      expect(core.getSnapshot().state).toBe("error");

      // audio chunk should be ignored when in error+disconnected state
      lastSocket?.simulateMessage(new Uint8Array(320).buffer);
      // Error state should remain
      expect(core.getSnapshot().error).not.toBe(null);
    });
  });

  // ─── Message parsing ──────────────────────────────────────────────────────

  describe("message parsing", () => {
    beforeEach(() => {
      core.connect();
      lastSocket?.simulateOpen();
    });

    it("invalid JSON is logged and dropped", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
      lastSocket?.simulateMessage("not valid json {{{");
      expect(warnSpy).toHaveBeenCalledWith("session-core: invalid JSON; dropping");
      expect(core.getSnapshot().state).toBe("ready");
      warnSpy.mockRestore();
    });

    it("unknown server message type is silently dropped", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
      // A well-formed JSON object with a type not in the schema — lenientParse returns malformed:false
      lastSocket?.simulateMessage(JSON.stringify({ type: "totally_unknown_type_xyz" }));
      expect(warnSpy).not.toHaveBeenCalled();
      expect(core.getSnapshot().state).toBe("ready");
      warnSpy.mockRestore();
    });

    it("non-string non-binary frame is dropped with a console warning", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
      // Dispatch a numeric data value directly to bypass simulateMessage type checks
      for (const cb of (
        lastSocket as unknown as { _listeners: Map<string, Set<(...a: unknown[]) => void>> }
      )._listeners.get("message") ?? []) {
        cb({ data: 42 });
      }
      expect(warnSpy).toHaveBeenCalledWith(
        "session-core: non-string, non-binary frame received; dropping",
      );
      expect(core.getSnapshot().state).toBe("ready");
      warnSpy.mockRestore();
    });
  });

  // ─── Config message handling ────────────────────────────────────────────

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

      lastSocket?.simulateMessage(makeConfig(16_000, 24_000, "sess-123"));
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

      // sessionId="" is falsy — onSessionId should not be called
      lastSocket?.simulateMessage(makeConfig(16_000, 24_000, ""));
      expect(onSessionId).not.toHaveBeenCalled();
    });
  });

  // ─── send/sendJson ──────────────────────────────────────────────────────

  describe("send and cancel", () => {
    it("cancel sends JSON cancel message when connected", () => {
      core.connect();
      lastSocket?.simulateOpen();
      core.cancel();
      expect(lastSocket?.send).toHaveBeenCalledTimes(1);
      const sent = lastSocket?.send.mock.calls[0]?.[0];
      expect(typeof sent).toBe("string");
      const msg = JSON.parse(sent as string);
      expect(msg.type).toBe("cancel");
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("cancel does not throw when disconnected", () => {
      // send() should silently no-op when ws is null
      expect(() => core.cancel()).not.toThrow();
    });
  });

  // ─── reset ──────────────────────────────────────────────────────────────

  describe("reset", () => {
    it("sends JSON reset message when WebSocket is open", () => {
      core.connect();
      lastSocket?.simulateOpen();
      core.reset();
      expect(lastSocket?.send).toHaveBeenCalledTimes(1);
      const sent = lastSocket?.send.mock.calls[0]?.[0];
      expect(typeof sent).toBe("string");
      const msg = JSON.parse(sent as string);
      expect(msg.type).toBe("reset");
    });

    it("disconnects and reconnects when WebSocket is not open", () => {
      core.connect();
      // Don't simulate open — ws.readyState is still 0
      core.reset();
      // Should disconnect and reconnect: state should be connecting
      expect(core.getSnapshot().state).toBe("connecting");
    });
  });

  // ─── URL building ───────────────────────────────────────────────────────

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
      // Send a config to mark hasConnected=true
      lastSocket?.simulateMessage(makeConfig());
      // Disconnect and reconnect
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

  // ─── Reconnection with history ──────────────────────────────────────────

  describe("reconnection", () => {
    it("sends JSON history message on reconnect if messages exist", () => {
      // First connection
      core.connect();
      lastSocket?.simulateOpen();
      lastSocket?.simulateMessage(makeConfig());

      // Accumulate a message
      lastSocket?.simulateMessage(JSON.stringify({ type: "user_transcript", text: "Hello" }));
      expect(core.getSnapshot().messages).toHaveLength(1);

      // Disconnect and reconnect
      core.disconnect();
      core.connect();
      const reconnectSocket = lastSocket;
      reconnectSocket?.simulateOpen();

      // Send config to trigger history send
      reconnectSocket?.simulateMessage(makeConfig());

      // Should have sent a JSON history message
      const calls = reconnectSocket?.send.mock.calls ?? [];
      expect(calls.length).toBeGreaterThan(0);
      // Find the history message
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

  // ─── Multiple rapid connects (generation counter) ─────────────────────

  describe("rapid reconnect (generation counter)", () => {
    it("ignores events from a stale connection after reconnect", () => {
      core.connect();
      const firstSocket = lastSocket;
      firstSocket?.simulateOpen();

      // Immediately reconnect — bumps the generation counter
      core.connect();
      const secondSocket = lastSocket;
      expect(secondSocket).not.toBe(firstSocket);

      secondSocket?.simulateOpen();

      // Events from the first socket's listeners have been cleaned up
      // by the AbortController, so they won't fire. The second socket
      // should be functional:
      secondSocket?.simulateMessage(JSON.stringify({ type: "speech_started" }));
      expect(core.getSnapshot().userTranscript).toBe("");
    });
  });

  // ─── Multi-message conversation flow ──────────────────────────────────

  describe("conversation flow", () => {
    beforeEach(() => {
      core.connect();
      lastSocket?.simulateOpen();
    });

    it("handles a full turn: speech → transcript → thinking → speaking → listening", () => {
      // User starts speaking
      lastSocket?.simulateMessage(JSON.stringify({ type: "speech_started" }));
      expect(core.getSnapshot().userTranscript).toBe("");

      // Speech stops
      lastSocket?.simulateMessage(JSON.stringify({ type: "speech_stopped" }));

      // Transcript arrives
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user_transcript", text: "What time is it?" }),
      );
      expect(core.getSnapshot().state).toBe("thinking");
      expect(core.getSnapshot().messages).toHaveLength(1);

      // Agent responds with text
      lastSocket?.simulateMessage(JSON.stringify({ type: "agent_transcript", text: "It is 3pm." }));
      expect(core.getSnapshot().messages).toHaveLength(2);

      // Audio starts playing (raw binary)
      lastSocket?.simulateMessage(new Uint8Array(320).buffer);
      expect(core.getSnapshot().state).toBe("speaking");

      // Audio done
      lastSocket?.simulateMessage(JSON.stringify({ type: "audio_done" }));
      expect(core.getSnapshot().state).toBe("listening");

      // Reply done
      lastSocket?.simulateMessage(JSON.stringify({ type: "reply_done" }));
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("handles a turn with tool calls", () => {
      // User message
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user_transcript", text: "Search for cats" }),
      );

      // Tool call started
      lastSocket?.simulateMessage(
        JSON.stringify({
          type: "tool_call",
          toolCallId: "tc-1",
          toolName: "web_search",
          args: { query: "cats" },
        }),
      );
      expect(core.getSnapshot().toolCalls).toHaveLength(1);
      expect(core.getSnapshot().toolCalls[0]?.status).toBe("pending");

      // Tool call done
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool_call_done", toolCallId: "tc-1", result: "Found 42 cats" }),
      );
      expect(core.getSnapshot().toolCalls[0]?.status).toBe("done");
      expect(core.getSnapshot().toolCalls[0]?.result).toBe("Found 42 cats");

      // Agent responds
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "agent_transcript", text: "I found 42 cats." }),
      );
      expect(core.getSnapshot().messages).toHaveLength(2);
    });

    it("tool call afterMessageIndex tracks insertion point", () => {
      // Two user messages first
      lastSocket?.simulateMessage(JSON.stringify({ type: "user_transcript", text: "msg1" }));
      lastSocket?.simulateMessage(JSON.stringify({ type: "agent_transcript", text: "reply1" }));
      lastSocket?.simulateMessage(JSON.stringify({ type: "user_transcript", text: "msg2" }));
      expect(core.getSnapshot().messages).toHaveLength(3);

      // Tool call after 3 messages (index 2)
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool_call", toolCallId: "tc-1", toolName: "calc", args: {} }),
      );
      expect(core.getSnapshot().toolCalls[0]?.afterMessageIndex).toBe(2);
    });
  });
});
