// Copyright 2025 the AAI authors. MIT license.
/**
 * session-core tests: state machine, connection lifecycle, server event
 * handling, and binary audio frames. Messaging/reconnection tests live in
 * session-core-messaging.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConstructorType,
  lastSocket,
  MockWebSocket,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";

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

    it("user_transcript_partial sets the live userTranscript without touching messages", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user_transcript_partial", text: "hello wor" }),
      );
      const snap = core.getSnapshot();
      expect(snap.userTranscript).toBe("hello wor");
      expect(snap.messages).toEqual([]);
    });

    it("user_transcript after partials commits the message and clears the live transcript", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user_transcript_partial", text: "hello wor" }),
      );
      lastSocket?.simulateMessage(JSON.stringify({ type: "user_transcript", text: "Hello world" }));
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([{ role: "user", content: "Hello world" }]);
      expect(snap.userTranscript).toBe(null);
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
});
