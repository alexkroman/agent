// Copyright 2025 the AAI authors. MIT license.
/**
 * session-core tests: state machine, connection lifecycle, server event
 * handling, and binary audio frames. Messaging/reconnection tests live in
 * session-core-messaging.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lastSocket,
  MockWebSocketConstructor,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createBrowserSession } from "./session-core.ts";
import type { BrowserSession } from "./session-core-types.ts";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("createBrowserSession", () => {
  let core: BrowserSession;

  beforeEach(() => {
    resetLastSocket();
    core = createBrowserSession({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocketConstructor,
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

  it("a refusal close REPORTS the server's own reason", () => {
    // The guest closes 1011 with a sentence that already says what to do — a
    // missing provider credential names the variable to set. This handler used
    // to drop `event.reason` entirely, so the one thing a misconfigured
    // deployment needed to be told surfaced as a plain disconnect.
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateClose(1011, "Anthropic LLM: missing API key. Set ANTHROPIC_API_KEY.");

    expect(core.getSnapshot().state).toBe("error");
    expect(core.getSnapshot().error?.message).toBe(
      "Anthropic LLM: missing API key. Set ANTHROPIC_API_KEY.",
    );
  });

  it("a NORMAL close with a reason is still just a disconnect", () => {
    // 1000 is the caller hanging up or the server retiring a finished session;
    // showing text there would turn an ordinary ending into an error banner.
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateClose(1000, "bye");

    expect(core.getSnapshot().state).toBe("disconnected");
    expect(core.getSnapshot().error).toBe(null);
  });

  it("start sets started and running then connects", () => {
    core.start();
    const snap = core.getSnapshot();
    expect(snap.started).toBe(true);
    expect(snap.running).toBe(true);
    expect(snap.state).toBe("connecting");
  });

  // ─── End ────────────────────────────────────────────────────────────────

  it("end returns to the not-started state and clears the conversation", () => {
    core.start();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(JSON.stringify({ type: "speech.started" }));
    const socket = lastSocket;

    core.end();

    const snap = core.getSnapshot();
    expect(snap.started).toBe(false);
    expect(snap.running).toBe(false);
    expect(snap.state).toBe("disconnected");
    expect(snap.messages).toEqual([]);
    expect(snap.userTranscript).toBe(null);
    expect(snap.error).toBe(null);
    expect(socket?.close).toHaveBeenCalled();
  });

  it("end drops the resume id so the next start is a fresh session", () => {
    core.start();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(makeConfig());

    core.end();
    core.start();

    // A brand-new session: no `?sessionId=` resume and no greeting
    // suppression on the fresh connection.
    expect(lastSocket?.url).not.toContain("sessionId=");
    expect(lastSocket?.url).not.toContain("resume=");
  });

  it("reset on a closed socket redials as a fresh session, not a resume", () => {
    // "New Conversation" while the link is down: the `reset` frame has nowhere
    // to go, so the redial is what starts the new conversation. Carrying the
    // resume id would rejoin the old one — the server keeps the history this
    // reset discarded, and `skipGreeting` suppresses the opening line.
    core.start();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(makeConfig());
    lastSocket?.simulateClose();

    core.reset();

    expect(lastSocket?.url).not.toContain("sessionId=");
    expect(lastSocket?.url).not.toContain("resume=");
    const snap = core.getSnapshot();
    expect(snap.running).toBe(true);
    expect(snap.started).toBe(true);
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
      lastSocket?.simulateMessage(JSON.stringify({ type: "speech.started" }));
      expect(core.getSnapshot().userTranscript).toBe("");
    });

    it("speech_stopped is handled without error", () => {
      lastSocket?.simulateMessage(JSON.stringify({ type: "speech.stopped" }));
      // speech_stopped is a no-op, state shouldn't change
      expect(core.getSnapshot().state).toBe("ready");
    });

    it("user_transcript_partial sets the live userTranscript without touching messages", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user-transcript.updated", text: "hello wor" }),
      );
      const snap = core.getSnapshot();
      expect(snap.userTranscript).toBe("hello wor");
      expect(snap.messages).toEqual([]);
    });

    it("user_transcript after partials commits the message and clears the live transcript", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user-transcript.updated", text: "hello wor" }),
      );
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user-transcript.committed", text: "Hello world" }),
      );
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([{ id: 1, role: "user", content: "Hello world" }]);
      expect(snap.userTranscript).toBe(null);
    });

    it("user_transcript appends user message and sets state to thinking", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user-transcript.committed", text: "Hello world" }),
      );
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([{ id: 1, role: "user", content: "Hello world" }]);
      expect(snap.userTranscript).toBe(null);
      expect(snap.state).toBe("thinking");
    });

    it("agent_transcript renders live and commits on reply_done", () => {
      // Cumulative within a reply: pipeline mode sends one per piece of speech,
      // so each is the caption to show, not a turn of its own.
      lastSocket?.simulateMessage(JSON.stringify({ type: "agent-transcript.updated", text: "Hi" }));
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "agent-transcript.updated", text: "Hi there" }),
      );
      expect(core.getSnapshot().agentTranscript).toBe("Hi there");
      expect(core.getSnapshot().messages).toEqual([]);

      lastSocket?.simulateMessage(JSON.stringify({ type: "reply.completed" }));
      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([{ id: 1, role: "assistant", content: "Hi there" }]);
      expect(snap.agentTranscript).toBe(null);
    });

    it("keeps what the caller heard when a reply is cancelled", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "agent-transcript.updated", text: "The total is" }),
      );
      lastSocket?.simulateMessage(JSON.stringify({ type: "reply.cancelled" }));
      expect(core.getSnapshot().messages).toEqual([
        { id: 1, role: "assistant", content: "The total is" },
      ]);
    });

    it("assigns monotonic ids to messages across roles", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user-transcript.committed", text: "one" }),
      );
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "agent-transcript.updated", text: "two" }),
      );
      lastSocket?.simulateMessage(JSON.stringify({ type: "reply.completed" }));
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user-transcript.committed", text: "three" }),
      );
      expect(core.getSnapshot().messages.map((m) => m.id)).toEqual([1, 2, 3]);
    });

    it("tool_call adds pending tool call", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({
          type: "tool.called",
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
          type: "tool.called",
          toolCallId: "tc-1",
          toolName: "search",
          args: { query: "test" },
        }),
      );
      // Then complete it
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool.completed", toolCallId: "tc-1", result: "found it" }),
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
        JSON.stringify({ type: "tool.completed", toolCallId: "unknown-id", result: "result" }),
      );
      // Should not throw, toolCalls should remain empty
      expect(core.getSnapshot().toolCalls).toEqual([]);
    });

    it("reply_done transitions state to listening", () => {
      lastSocket?.simulateMessage(JSON.stringify({ type: "reply.completed" }));
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("cancelled resets transcripts and transitions to listening", () => {
      // Set up some transcript state
      lastSocket?.simulateMessage(JSON.stringify({ type: "speech.started" }));
      expect(core.getSnapshot().userTranscript).toBe("");

      lastSocket?.simulateMessage(JSON.stringify({ type: "reply.cancelled" }));
      const snap = core.getSnapshot();
      expect(snap.userTranscript).toBe(null);
      expect(snap.agentTranscript).toBe(null);
      expect(snap.state).toBe("listening");
    });

    it("reset clears all state and transitions to listening", () => {
      // Accumulate some state
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user-transcript.committed", text: "msg1" }),
      );
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool.called", toolCallId: "tc-1", toolName: "t", args: {} }),
      );
      expect(core.getSnapshot().messages).toHaveLength(1);

      lastSocket?.simulateMessage(JSON.stringify({ type: "session.reset" }));
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
        JSON.stringify({
          type: "error.reported",
          code: "internal",
          message: "Something broke",
          fatal: true,
        }),
      );
      const snap = core.getSnapshot();
      expect(snap.state).toBe("error");
      expect(snap.error).toEqual({ code: "internal", message: "Something broke", fatal: true });
      expect(snap.running).toBe(false);
    });

    it("non-error event clears a NON-FATAL error banner", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "error.reported", code: "internal", message: "fail", fatal: false }),
      );
      expect(core.getSnapshot().error?.message).toBe("fail");

      // The session kept running, so later activity retires the banner.
      lastSocket?.simulateMessage(JSON.stringify({ type: "speech.started" }));
      const snap = core.getSnapshot();
      expect(snap.state).not.toBe("error");
      expect(snap.error).toBe(null);
    });

    it("a non-error event does NOT clear a fatal one — the session is over", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "error.reported", code: "internal", message: "fail", fatal: true }),
      );
      expect(core.getSnapshot().state).toBe("error");

      lastSocket?.simulateMessage(JSON.stringify({ type: "speech.started" }));
      const snap = core.getSnapshot();
      expect(snap.state).toBe("error");
      expect(snap.error).toEqual({ code: "internal", message: "fail", fatal: true });
    });
  });

  // ─── contentVersion ───────────────────────────────────────────────────────

  describe("contentVersion", () => {
    beforeEach(() => {
      core.connect();
      lastSocket?.simulateOpen();
    });

    it("does not bump on state-only changes", () => {
      const v0 = core.getSnapshot().contentVersion;
      lastSocket?.simulateMessage(JSON.stringify({ type: "reply.completed" }));
      expect(core.getSnapshot().state).toBe("listening");
      expect(core.getSnapshot().contentVersion).toBe(v0);
    });

    it("bumps when messages, tool calls, or transcripts change", () => {
      const v0 = core.getSnapshot().contentVersion;
      lastSocket?.simulateMessage(JSON.stringify({ type: "speech.started" }));
      const v1 = core.getSnapshot().contentVersion;
      expect(v1).toBeGreaterThan(v0);

      lastSocket?.simulateMessage(
        JSON.stringify({ type: "user-transcript.committed", text: "hi" }),
      );
      const v2 = core.getSnapshot().contentVersion;
      expect(v2).toBeGreaterThan(v1);

      lastSocket?.simulateMessage(
        JSON.stringify({ type: "tool.called", toolCallId: "tc-1", toolName: "t", args: {} }),
      );
      expect(core.getSnapshot().contentVersion).toBeGreaterThan(v2);
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

      lastSocket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
      // Without voiceIO, the done handler calls updateState directly
      expect(core.getSnapshot().state).toBe("listening");
    });

    it("audio chunk ignored in error state with error set", () => {
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "error.reported", code: "internal", message: "fail", fatal: true }),
      );
      expect(core.getSnapshot().state).toBe("error");

      // audio chunk should be ignored when in error+disconnected state
      lastSocket?.simulateMessage(new Uint8Array(320).buffer);
      // The STATE is what the guard protects. `error` alone proves nothing:
      // `fatalError` latches it (see "A FATAL error must survive the frames
      // that follow it"), so deleting the guard flips the state to "speaking"
      // while leaving the banner up — a dead session reading as live, which is
      // exactly the failure, and the old assertion held through it.
      expect(core.getSnapshot().state).toBe("error");
      expect(core.getSnapshot().error).not.toBe(null);
    });
  });
});
