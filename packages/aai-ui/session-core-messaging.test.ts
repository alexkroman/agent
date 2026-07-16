// Copyright 2025 the AAI authors. MIT license.
/**
 * session-core tests: audio buffering, message parsing, config handling,
 * send/cancel/reset, URL building, reconnection, and conversation flow.
 * State-machine and event-handling tests live in session-core.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AudioMockContext, findWorkletNode, installAudioMocks } from "./_react-test-utils.ts";
import {
  type ConstructorType,
  lastSocket,
  MockWebSocket,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";
import { MIC_SEND_MAX_BUFFERED_BYTES } from "./types.ts";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createSessionCore", () => {
  let core: SessionCore;

  beforeEach(() => {
    resetLastSocket();
    core = createSessionCore({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocket as unknown as ConstructorType,
    });
  });

  afterEach(() => {
    core.disconnect();
  });

  // ─── Pre-init audio buffering ─────────────────────────────────────────────

  describe("audio chunk buffering during audio init", () => {
    let audio: AudioMockContext & { restore: () => void };

    beforeEach(() => {
      audio = installAudioMocks();
    });

    afterEach(() => {
      audio.restore();
    });

    it("replays chunks that arrive before voiceIO is initialized", async () => {
      core.connect();
      lastSocket?.simulateOpen();

      // Config message kicks off async initAudioCapture. Send binary chunks
      // synchronously before any microtask can advance the init pipeline —
      // this reproduces the race where the S2S greeting starts streaming
      // before the client's playback worklet exists.
      lastSocket?.simulateMessage(makeConfig());
      const chunk1 = new Uint8Array([1, 2, 3, 4]);
      const chunk2 = new Uint8Array([5, 6, 7, 8]);
      lastSocket?.simulateMessage(chunk1.buffer);
      lastSocket?.simulateMessage(chunk2.buffer);

      // initAudioCapture creates the playback worklet lazily on first enqueue.
      // Wait until it appears, which confirms the buffer was drained.
      await vi.waitFor(() => {
        expect(audio.workletNodes().some((n) => n.name === "playback-processor")).toBe(true);
      });

      const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");
      const writes = playNode.port.posted.filter(
        (p): p is { event: "write"; buffer: Uint8Array } =>
          (p as { event?: string }).event === "write",
      );
      expect(writes.length).toBe(2);
      const buffers = writes.map((w) => Array.from(w.buffer));
      expect(buffers).toEqual([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ]);
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

    it("tool call afterMessageId anchors to the last message at insert time", () => {
      // Three messages first (ids 1, 2, 3)
      lastSocket?.simulateMessage(JSON.stringify({ type: "user_transcript", text: "msg1" }));
      lastSocket?.simulateMessage(JSON.stringify({ type: "agent_transcript", text: "reply1" }));
      lastSocket?.simulateMessage(JSON.stringify({ type: "user_transcript", text: "msg2" }));
      expect(core.getSnapshot().messages).toHaveLength(3);

      // Tool call after 3 messages anchors to the message with id 3
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool_call", toolCallId: "tc-1", toolName: "calc", args: {} }),
      );
      expect(core.getSnapshot().toolCalls[0]?.afterMessageId).toBe(3);
    });

    it("tool call inserted before any message anchors to -1", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool_call", toolCallId: "tc-1", toolName: "calc", args: {} }),
      );
      expect(core.getSnapshot().toolCalls[0]?.afterMessageId).toBe(-1);
    });

    it("tool call seq is monotonic across insertions", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool_call", toolCallId: "tc-1", toolName: "a", args: {} }),
      );
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool_call", toolCallId: "tc-2", toolName: "b", args: {} }),
      );
      expect(core.getSnapshot().toolCalls.map((tc) => tc.seq)).toEqual([1, 2]);
    });
  });

  // ─── Mic send backpressure ──────────────────────────────────────────────

  describe("mic send backpressure", () => {
    let audio: AudioMockContext & { restore: () => void };

    beforeEach(() => {
      audio = installAudioMocks();
    });

    afterEach(() => {
      audio.restore();
    });

    it("drops mic frames while ws.bufferedAmount exceeds the threshold", async () => {
      core.connect();
      const socket = lastSocket;
      socket?.simulateOpen();
      socket?.simulateMessage(makeConfig());

      // Wait for initAudioCapture to wire the capture worklet's onmessage.
      await vi.waitFor(() => {
        expect(audio.workletNodes().some((n) => n.name === "capture-processor")).toBe(true);
        expect(
          findWorkletNode(audio.workletNodes(), "capture-processor").port.onmessage,
        ).not.toBeNull();
      });
      const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");
      const binarySends = () =>
        (socket?.send.mock.calls ?? []).filter((c) => typeof c[0] !== "string");

      if (socket) socket.bufferedAmount = MIC_SEND_MAX_BUFFERED_BYTES + 1;
      capNode.port.simulateMessage({ event: "chunk", buffer: new ArrayBuffer(320) });
      expect(binarySends()).toHaveLength(0);

      // Once the queue drains below the threshold, frames flow again.
      if (socket) socket.bufferedAmount = 0;
      capNode.port.simulateMessage({ event: "chunk", buffer: new ArrayBuffer(320) });
      expect(binarySends()).toHaveLength(1);
    });
  });
});
