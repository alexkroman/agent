// Copyright 2025 the AAI authors. MIT license.

import {
  decodeC2S,
  encAgentTranscript,
  encAudioChunkS2C,
  encAudioDone,
  encCancelled,
  encConfig,
  encError,
  encReplyDone,
  encResetS2C,
  encSpeechStarted,
  encSpeechStopped,
  encToolCall,
  encToolCallDone,
  encUserTranscript,
} from "@alexkroman1/aai/wire";
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

  /** Simulate receiving a binary message from the server. */
  simulateMessage(data: Uint8Array | ArrayBuffer) {
    const buf = data instanceof Uint8Array ? data.buffer : data;
    for (const cb of this._listeners.get("message") ?? []) {
      cb({ data: buf });
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

// ─── Helper to encode a config frame ────────────────────────────────────────

function makeConfig(sampleRate = 16_000, ttsSampleRate = 24_000, sid = "sess-123"): Uint8Array {
  return encConfig({ sampleRate, ttsSampleRate, sid });
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
      lastSocket?.simulateMessage(encSpeechStarted());
      expect(core.getSnapshot().userTranscript).toBe("");
    });

    it("speech_stopped is handled without error", () => {
      lastSocket?.simulateMessage(encSpeechStopped());
      // speech_stopped is a no-op, state shouldn't change
      expect(core.getSnapshot().state).toBe("ready");
    });

    it("user_transcript appends user message and sets state to thinking", () => {
      lastSocket?.simulateMessage(encUserTranscript("Hello world"));
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([{ role: "user", content: "Hello world" }]);
      expect(snap.userTranscript).toBe(null);
      expect(snap.state).toBe("thinking");
    });

    it("agent_transcript appends assistant message", () => {
      lastSocket?.simulateMessage(encAgentTranscript("Hi there"));
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([{ role: "assistant", content: "Hi there" }]);
      expect(snap.agentTranscript).toBe(null);
    });

    it("tool_call adds pending tool call", () => {
      const frame = encToolCall("tc-1", "search", { query: "test" });
      if (!frame) throw new Error("encToolCall returned null");
      lastSocket?.simulateMessage(frame);
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
      const callFrame = encToolCall("tc-1", "search", { query: "test" });
      if (!callFrame) throw new Error("encToolCall returned null");
      lastSocket?.simulateMessage(callFrame);
      // Then complete it
      lastSocket?.simulateMessage(encToolCallDone("tc-1", "found it"));
      const snap = core.getSnapshot();
      expect(snap.toolCalls).toHaveLength(1);
      expect(snap.toolCalls[0]).toMatchObject({
        callId: "tc-1",
        status: "done",
        result: "found it",
      });
    });

    it("tool_call_done ignores unknown toolCallId", () => {
      lastSocket?.simulateMessage(encToolCallDone("unknown-id", "result"));
      // Should not throw, toolCalls should remain empty
      expect(core.getSnapshot().toolCalls).toEqual([]);
    });

    it("reply_done transitions state to listening", () => {
      lastSocket?.simulateMessage(encReplyDone());
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("cancelled resets transcripts and transitions to listening", () => {
      // Set up some transcript state
      lastSocket?.simulateMessage(encSpeechStarted());
      expect(core.getSnapshot().userTranscript).toBe("");

      lastSocket?.simulateMessage(encCancelled());
      const snap = core.getSnapshot();
      expect(snap.userTranscript).toBe(null);
      expect(snap.agentTranscript).toBe(null);
      expect(snap.state).toBe("listening");
    });

    it("reset clears all state and transitions to listening", () => {
      // Accumulate some state
      lastSocket?.simulateMessage(encUserTranscript("msg1"));
      const callFrame = encToolCall("tc-1", "t", {});
      if (!callFrame) throw new Error("encToolCall returned null");
      lastSocket?.simulateMessage(callFrame);
      expect(core.getSnapshot().messages).toHaveLength(1);

      lastSocket?.simulateMessage(encResetS2C());
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([]);
      expect(snap.toolCalls).toEqual([]);
      expect(snap.userTranscript).toBe(null);
      expect(snap.agentTranscript).toBe(null);
      expect(snap.error).toBe(null);
      expect(snap.state).toBe("listening");
    });

    it("error event sets error state and stops running", () => {
      lastSocket?.simulateMessage(encError("internal", "Something broke"));
      const snap = core.getSnapshot();
      expect(snap.state).toBe("error");
      expect(snap.error).toEqual({ code: "internal", message: "Something broke" });
      expect(snap.running).toBe(false);
    });

    it("non-error event clears error state", () => {
      // Set error state
      lastSocket?.simulateMessage(encError("internal", "fail"));
      expect(core.getSnapshot().state).toBe("error");

      // Any non-error event should clear it
      lastSocket?.simulateMessage(encSpeechStarted());
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

    it("audio_chunk frame transitions state to speaking", () => {
      const pcm = new Uint8Array(320);
      lastSocket?.simulateMessage(encAudioChunkS2C(pcm));
      expect(core.getSnapshot().state).toBe("speaking");
    });

    it("subsequent audio_chunk frames stay in speaking state", () => {
      lastSocket?.simulateMessage(encAudioChunkS2C(new Uint8Array(320)));
      lastSocket?.simulateMessage(encAudioChunkS2C(new Uint8Array(320)));
      expect(core.getSnapshot().state).toBe("speaking");
    });

    it("audio_done transitions back to listening", async () => {
      lastSocket?.simulateMessage(encAudioChunkS2C(new Uint8Array(320)));
      expect(core.getSnapshot().state).toBe("speaking");

      lastSocket?.simulateMessage(encAudioDone());
      // Without voiceIO, the done handler calls updateState directly
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("audio_chunk ignored in error state with error set", () => {
      lastSocket?.simulateMessage(encError("internal", "fail"));
      expect(core.getSnapshot().state).toBe("error");

      // audio_chunk should be ignored when in error+disconnected state
      lastSocket?.simulateMessage(encAudioChunkS2C(new Uint8Array(320)));
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

    it("non-binary frame is dropped with a console warning", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
      // Simulate a text/string frame (should be dropped in binary-only protocol)
      for (const cb of (
        lastSocket as unknown as { _listeners: Map<string, Set<(...a: unknown[]) => void>> }
      )._listeners.get("message") ?? []) {
        cb({ data: "not binary" });
      }
      expect(warnSpy).toHaveBeenCalledWith("session-core: non-binary frame received; dropping");
      expect(core.getSnapshot().state).toBe("ready");
      warnSpy.mockRestore();
    });

    it("truncated/invalid binary frame is dropped with a console warning", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
      // Empty ArrayBuffer — decode will fail
      lastSocket?.simulateMessage(new Uint8Array(0));
      expect(warnSpy).toHaveBeenCalledWith("session-core: wire decode failed:", "empty frame");
      expect(core.getSnapshot().state).toBe("ready");
      warnSpy.mockRestore();
    });

    it("unknown message type byte is dropped silently", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
      // Byte 0x7f is not a valid S2C type code
      lastSocket?.simulateMessage(new Uint8Array([0x7f]));
      expect(warnSpy).toHaveBeenCalled();
      expect(core.getSnapshot().state).toBe("ready");
      warnSpy.mockRestore();
    });
  });

  // ─── Config message handling ────────────────────────────────────────────

  describe("config message", () => {
    it("calls onSessionId when config includes sid", () => {
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

    it("handles config with empty sid (no onSessionId call expected)", () => {
      const onSessionId = vi.fn();
      core = createSessionCore({
        platformUrl: "ws://localhost:3000",
        WebSocket: MockWebSocket as unknown as ConstructorType,
        onSessionId,
      });
      core.connect();
      lastSocket?.simulateOpen();

      // sid="" is falsy — onSessionId should not be called
      lastSocket?.simulateMessage(makeConfig(16_000, 24_000, ""));
      expect(onSessionId).not.toHaveBeenCalled();
    });
  });

  // ─── send/sendBinary ────────────────────────────────────────────────────

  describe("send and cancel", () => {
    it("cancel sends binary cancel frame when connected", () => {
      core.connect();
      lastSocket?.simulateOpen();
      core.cancel();
      expect(lastSocket?.send).toHaveBeenCalledTimes(1);
      // Verify the sent frame is a CANCEL frame (byte 0 = 0x02)
      const sent = lastSocket?.send.mock.calls[0]?.[0];
      expect(sent).toBeDefined();
      const sentBytes = sent instanceof Uint8Array ? sent : new Uint8Array(sent as ArrayBuffer);
      expect(sentBytes[0]).toBe(0x02); // C2S.CANCEL
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("cancel does not throw when disconnected", () => {
      // send() should silently no-op when ws is null
      expect(() => core.cancel()).not.toThrow();
    });
  });

  // ─── reset ──────────────────────────────────────────────────────────────

  describe("reset", () => {
    it("sends binary reset frame when WebSocket is open", () => {
      core.connect();
      lastSocket?.simulateOpen();
      core.reset();
      expect(lastSocket?.send).toHaveBeenCalledTimes(1);
      // Verify the sent frame is a RESET frame (byte 0 = 0x03)
      const sent = lastSocket?.send.mock.calls[0]?.[0];
      const sentBytes = sent instanceof Uint8Array ? sent : new Uint8Array(sent as ArrayBuffer);
      expect(sentBytes[0]).toBe(0x03); // C2S.RESET
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
    it("sends binary history frame on reconnect if messages exist", () => {
      // First connection
      core.connect();
      lastSocket?.simulateOpen();
      lastSocket?.simulateMessage(makeConfig());

      // Accumulate a message
      lastSocket?.simulateMessage(encUserTranscript("Hello"));
      expect(core.getSnapshot().messages).toHaveLength(1);

      // Disconnect and reconnect
      core.disconnect();
      core.connect();
      const reconnectSocket = lastSocket;
      reconnectSocket?.simulateOpen();

      // Send config to trigger history send
      reconnectSocket?.simulateMessage(makeConfig());

      // Should have sent a binary history frame
      const calls = reconnectSocket?.send.mock.calls ?? [];
      expect(calls.length).toBeGreaterThan(0);
      // Find the history frame (byte 0 = 0x04 = C2S.HISTORY)
      const historyCall = calls.find((c) => {
        const bytes = c[0] instanceof Uint8Array ? c[0] : new Uint8Array(c[0] as ArrayBuffer);
        return bytes[0] === 0x04;
      });
      expect(historyCall).toBeDefined();
      // Decode and verify
      const bytes =
        historyCall?.[0] instanceof Uint8Array
          ? historyCall[0]
          : new Uint8Array(historyCall?.[0] as ArrayBuffer);
      const decoded = decodeC2S(bytes);
      expect(decoded.ok).toBe(true);
      if (decoded.ok && decoded.data.type === "history") {
        expect(decoded.data.messages).toEqual([{ role: "user", content: "Hello" }]);
      }
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
      secondSocket?.simulateMessage(encSpeechStarted());
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
      lastSocket?.simulateMessage(encSpeechStarted());
      expect(core.getSnapshot().userTranscript).toBe("");

      // Speech stops
      lastSocket?.simulateMessage(encSpeechStopped());

      // Transcript arrives
      lastSocket?.simulateMessage(encUserTranscript("What time is it?"));
      expect(core.getSnapshot().state).toBe("thinking");
      expect(core.getSnapshot().messages).toHaveLength(1);

      // Agent responds with text
      lastSocket?.simulateMessage(encAgentTranscript("It is 3pm."));
      expect(core.getSnapshot().messages).toHaveLength(2);

      // Audio starts playing
      lastSocket?.simulateMessage(encAudioChunkS2C(new Uint8Array(320)));
      expect(core.getSnapshot().state).toBe("speaking");

      // Audio done
      lastSocket?.simulateMessage(encAudioDone());
      expect(core.getSnapshot().state).toBe("listening");

      // Reply done
      lastSocket?.simulateMessage(encReplyDone());
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("handles a turn with tool calls", () => {
      // User message
      lastSocket?.simulateMessage(encUserTranscript("Search for cats"));

      // Tool call started
      const callFrame = encToolCall("tc-1", "web_search", { query: "cats" });
      if (!callFrame) throw new Error("encToolCall returned null");
      lastSocket?.simulateMessage(callFrame);
      expect(core.getSnapshot().toolCalls).toHaveLength(1);
      expect(core.getSnapshot().toolCalls[0]?.status).toBe("pending");

      // Tool call done
      lastSocket?.simulateMessage(encToolCallDone("tc-1", "Found 42 cats"));
      expect(core.getSnapshot().toolCalls[0]?.status).toBe("done");
      expect(core.getSnapshot().toolCalls[0]?.result).toBe("Found 42 cats");

      // Agent responds
      lastSocket?.simulateMessage(encAgentTranscript("I found 42 cats."));
      expect(core.getSnapshot().messages).toHaveLength(2);
    });

    it("tool call afterMessageIndex tracks insertion point", () => {
      // Two user messages first
      lastSocket?.simulateMessage(encUserTranscript("msg1"));
      lastSocket?.simulateMessage(encAgentTranscript("reply1"));
      lastSocket?.simulateMessage(encUserTranscript("msg2"));
      expect(core.getSnapshot().messages).toHaveLength(3);

      // Tool call after 3 messages (index 2)
      const callFrame = encToolCall("tc-1", "calc", {});
      if (!callFrame) throw new Error("encToolCall returned null");
      lastSocket?.simulateMessage(callFrame);
      expect(core.getSnapshot().toolCalls[0]?.afterMessageIndex).toBe(2);
    });
  });
});
