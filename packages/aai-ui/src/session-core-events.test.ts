// Copyright 2026 the AAI authors. MIT license.
/**
 * Server-event handling in session-core-messages.ts: the capped snapshot
 * collections, transcript commits, error recovery, tool-call matching, and
 * the binary audio path's gating.
 *
 * Split from session-core.test.ts / session-core-messaging.test.ts, which
 * cover the connection lifecycle and the outbound wire; these are the
 * inbound-event branches those suites reach only incidentally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findWorkletNode, installAudioMocks } from "./_react-test-utils.ts";
import {
  lastSocket,
  type MockWebSocket,
  MockWebSocketConstructor,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createSessionCore } from "./session-core.ts";
import type { SessionCore } from "./session-core-types.ts";

/** Mirrors the module-private caps in session-core-messages.ts. */
const MAX_CUSTOM_EVENTS = 200;
const MAX_PREINIT_AUDIO_CHUNKS = 100;

describe("session-core server events", () => {
  let core: SessionCore;

  beforeEach(() => {
    resetLastSocket();
    core = createSessionCore({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocketConstructor,
    });
  });

  afterEach(() => {
    core.disconnect();
  });

  /** Open the socket and deliver the config frame. */
  function connect(): MockWebSocket {
    void core.start();
    const socket = lastSocket;
    if (!socket) throw new Error("no socket");
    socket.simulateOpen();
    socket.simulateMessage(makeConfig());
    return socket;
  }

  const send = (socket: MockWebSocket, event: Record<string, unknown>) =>
    socket.simulateMessage(JSON.stringify(event));

  describe("initial snapshot", () => {
    it("starts with every collection empty", () => {
      const snap = core.getSnapshot();
      expect(snap.customEvents).toEqual([]);
      expect(snap.messages).toEqual([]);
      expect(snap.toolCalls).toEqual([]);
      expect(snap.agentState).toBeNull();
      expect(snap.userTranscript).toBeNull();
      expect(snap.agentTranscript).toBeNull();
      expect(snap.error).toBeNull();
    });
  });

  describe("custom events", () => {
    it("appends in arrival order with a monotonic id", () => {
      const socket = connect();
      send(socket, { type: "custom.emitted", event: "order.placed", data: { total: 12 } });
      send(socket, { type: "custom.emitted", event: "order.shipped", data: null });

      expect(core.getSnapshot().customEvents).toEqual([
        { id: 1, event: "order.placed", data: { total: 12 } },
        { id: 2, event: "order.shipped", data: null },
      ]);
    });

    it("caps the list, dropping the oldest and keeping order", () => {
      // The cap has to hold exactly: one over and the list grows without
      // bound in a long session; a mis-sliced window drops the wrong end (or
      // nearly everything) while still looking "capped" from a length check
      // alone, which is why the surviving ids are asserted too.
      const socket = connect();
      for (let i = 1; i <= MAX_CUSTOM_EVENTS; i += 1) {
        send(socket, { type: "custom.emitted", event: `e${i}`, data: i });
      }
      const full = core.getSnapshot().customEvents;
      expect(full).toHaveLength(MAX_CUSTOM_EVENTS);
      expect(full.at(0)?.data).toBe(1);
      expect(full.at(-1)?.data).toBe(MAX_CUSTOM_EVENTS);

      send(socket, { type: "custom.emitted", event: "one-more", data: "last" });
      const capped = core.getSnapshot().customEvents;
      expect(capped).toHaveLength(MAX_CUSTOM_EVENTS);
      // The oldest is gone, the rest slid down by one, the newest is last.
      expect(capped.at(0)?.data).toBe(2);
      expect(capped.at(-2)?.data).toBe(MAX_CUSTOM_EVENTS);
      expect(capped.at(-1)?.data).toBe("last");
    });

    it("does not mutate the previous snapshot's array when capping", () => {
      // Snapshot collections are replaced, never mutated — useSyncExternalStore
      // compares by reference, so an in-place push is an invisible update.
      const socket = connect();
      for (let i = 1; i <= MAX_CUSTOM_EVENTS; i += 1) {
        send(socket, { type: "custom.emitted", event: `e${i}`, data: i });
      }
      const before = core.getSnapshot().customEvents;
      send(socket, { type: "custom.emitted", event: "one-more", data: "last" });

      expect(before).toHaveLength(MAX_CUSTOM_EVENTS);
      expect(before.at(-1)?.data).toBe(MAX_CUSTOM_EVENTS);
      expect(core.getSnapshot().customEvents).not.toBe(before);
    });
  });

  describe("agent_state", () => {
    it("replaces rather than accumulating", () => {
      // Only the newest value is meaningful — this is the agent's current
      // state, not a log of them.
      const socket = connect();
      send(socket, { type: "state.updated", state: { step: "looking-up" } });
      expect(core.getSnapshot().agentState).toEqual({ step: "looking-up" });

      send(socket, { type: "state.updated", state: { step: "answering" } });
      expect(core.getSnapshot().agentState).toEqual({ step: "answering" });
    });
  });

  describe("agent transcript commit", () => {
    it("moves spoken text into the conversation on reply_done", () => {
      const socket = connect();
      send(socket, { type: "agent-transcript.updated", text: "Hello there" });
      expect(core.getSnapshot().agentTranscript).toBe("Hello there");

      send(socket, { type: "reply.completed" });
      const snap = core.getSnapshot();
      expect(snap.agentTranscript).toBeNull();
      expect(snap.messages).toMatchObject([{ role: "assistant", content: "Hello there" }]);
      expect(snap.state).toBe("listening");
    });

    it("commits nothing for an empty reply, and clears the transcript", () => {
      // An empty string is not a message: appending it would put a blank
      // assistant bubble in the transcript for a turn that said nothing.
      const socket = connect();
      send(socket, { type: "agent-transcript.updated", text: "" });
      send(socket, { type: "reply.completed" });

      const snap = core.getSnapshot();
      expect(snap.messages).toEqual([]);
      expect(snap.agentTranscript).toBeNull();
    });

    it("keeps the text of a reply cut short by a barge-in", () => {
      // The caller heard that much; dropping it would leave the transcript
      // claiming the agent never spoke.
      const socket = connect();
      send(socket, { type: "agent-transcript.updated", text: "Let me check th" });
      send(socket, { type: "reply.cancelled" });

      const snap = core.getSnapshot();
      expect(snap.messages).toMatchObject([{ role: "assistant", content: "Let me check th" }]);
      expect(snap.userTranscript).toBeNull();
      expect(snap.state).toBe("listening");
    });
  });

  describe("error recovery", () => {
    it("logs the agent error with a prefix that names it", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, {
        type: "error.reported",
        code: "llm",
        message: "provider timeout",
        fatal: false,
      });

      expect(spy).toHaveBeenCalledWith("Agent error:", "provider timeout");
    });

    it("clears a lingering non-fatal banner on the next event", () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, {
        type: "error.reported",
        code: "llm",
        message: "one turn failed",
        fatal: false,
      });
      expect(core.getSnapshot().error).toEqual({ code: "llm", message: "one turn failed" });
      // The session kept running, so any later activity clears the banner.
      expect(core.getSnapshot().state).not.toBe("error");

      send(socket, { type: "speech.started" });
      expect(core.getSnapshot().error).toBeNull();
    });

    it("does not resurrect a fatal session when a later non-fatal error arrives", () => {
      // Error events must NOT run the recovery path: a second error is not
      // evidence that the first one is over.
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, {
        type: "error.reported",
        code: "internal",
        message: "session over",
        fatal: true,
      });
      expect(core.getSnapshot().state).toBe("error");

      send(socket, { type: "error.reported", code: "llm", message: "and another", fatal: false });
      expect(core.getSnapshot().state).toBe("error");
    });

    it("retires a NON-FATAL banner on a non-error event", () => {
      // The socket is demonstrably open and the server said the session
      // survived, so later activity clears the banner.
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, {
        type: "error.reported",
        code: "audio",
        message: "worklet failed",
        fatal: false,
      });
      expect(core.getSnapshot().error?.code).toBe("audio");

      send(socket, { type: "speech.started" });
      expect(core.getSnapshot().error).toBeNull();
    });

    it("a FATAL error survives every later frame, turn boundaries included", () => {
      // The host's fatal paths call `terminate()`, which emits `onCancelled()`
      // — so the frame announcing the session's death used to be the frame
      // that wiped the message explaining it. The missing-provider-key error
      // is the one this costs most: it names the fix.
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, {
        type: "error.reported",
        code: "tts",
        message: "Cartesia TTS: missing API key. Set CARTESIA_API_KEY in the agent env.",
        fatal: true,
      });
      send(socket, { type: "reply.cancelled" });
      send(socket, { type: "reply.completed" });
      send(socket, { type: "speech.started" });
      const snap = core.getSnapshot();
      expect(snap.state).toBe("error");
      expect(snap.error?.message).toContain("CARTESIA_API_KEY");
    });
  });

  describe("tool calls", () => {
    const toolCall = (id: string, name: string) => ({
      type: "tool.called",
      toolCallId: id,
      toolName: name,
      args: { q: id },
    });

    it("completes the call matching the id, not merely the first pending one", () => {
      const socket = connect();
      send(socket, toolCall("call-a", "search"));
      send(socket, toolCall("call-b", "lookup"));

      send(socket, { type: "tool.completed", toolCallId: "call-b", result: "b-result" });

      const [first, second] = core.getSnapshot().toolCalls;
      expect(first).toMatchObject({ callId: "call-a", status: "pending" });
      expect(second).toMatchObject({ callId: "call-b", status: "done", result: "b-result" });
    });

    it("completes a call that is not the first or last in the list", () => {
      // Index 1 specifically: a "not found" sentinel compared with the wrong
      // sign silently skips exactly this position.
      const socket = connect();
      for (const id of ["call-a", "call-b", "call-c"]) send(socket, toolCall(id, "t"));

      send(socket, { type: "tool.completed", toolCallId: "call-b", result: "b" });

      const statuses = core.getSnapshot().toolCalls.map((tc) => tc.status);
      expect(statuses).toEqual(["pending", "done", "pending"]);
    });

    it("ignores a result for a call it never saw, without churning state", () => {
      const socket = connect();
      send(socket, toolCall("call-a", "search"));
      const before = core.getSnapshot().toolCalls;

      send(socket, { type: "tool.completed", toolCallId: "never-seen", result: "x" });

      // Same array instance: an unknown id is not a state change, and
      // replacing the array re-renders every consumer that depends on it.
      expect(core.getSnapshot().toolCalls).toBe(before);
    });
  });

  describe("malformed frames", () => {
    it("warns about a frame with no usable type at all", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, { notAType: 1 });

      expect(spy).toHaveBeenCalledWith("session-core: malformed server message", expect.anything());
    });

    it("silently drops an unrecognised type (rolling-upgrade tolerance)", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, { type: "some_future_event", whatever: true });

      expect(spy).not.toHaveBeenCalled();
      expect(core.getSnapshot().error).toBeNull();
    });

    it("also drops a KNOWN type with an invalid payload, silently", () => {
      // Pinning current behavior, which is not quite what the code reads
      // like: `lenientParse` only reports `malformed` for a frame whose
      // envelope has no usable `type`, UNLESS the caller passes the known-type
      // set — and this call site does not. So a server sending
      // `agent_transcript` with a numeric `text` produces no diagnostic at
      // all, where the "unrecognised type" comment implies it would.
      const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, { type: "agent-transcript.updated", text: 42 });

      expect(spy).not.toHaveBeenCalled();
      expect(core.getSnapshot().agentTranscript).toBeNull();
    });

    it("drops a non-string, non-binary frame with a warning", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, { type: "agent-transcript.updated", text: "kept" });
      socket.simulateMessage("not json at all");

      expect(spy).toHaveBeenCalledWith("session-core: invalid JSON; dropping");
      expect(core.getSnapshot().agentTranscript).toBe("kept");
    });
  });

  describe("binary audio gating", () => {
    let audio: ReturnType<typeof installAudioMocks>;

    beforeEach(() => {
      audio = installAudioMocks();
    });

    afterEach(() => {
      audio.restore();
    });

    const chunk = () => new ArrayBuffer(8);

    it("plays audio while a non-fatal error banner is showing", () => {
      // A turn-level failure keeps the session usable, so the next reply's
      // audio must still reach the speaker.
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, {
        type: "error.reported",
        code: "llm",
        message: "one turn failed",
        fatal: false,
      });

      socket.simulateMessage(chunk());
      expect(core.getSnapshot().state).toBe("speaking");
    });

    it("ignores a straggler chunk on an errored session", () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, { type: "error.reported", code: "internal", message: "over", fatal: true });

      socket.simulateMessage(chunk());
      expect(core.getSnapshot().state).toBe("error");
    });

    it("ignores a straggler chunk after an error-driven disconnect", () => {
      // The socket closing on a fatal error leaves state "disconnected" with
      // the error still set; a late chunk must not flip that to "speaking".
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const socket = connect();
      send(socket, { type: "error.reported", code: "internal", message: "over", fatal: true });
      socket.simulateClose(1011);

      socket.simulateMessage(chunk());
      expect(core.getSnapshot().state).not.toBe("speaking");
    });

    it("caps the pre-init buffer, keeping the OLDEST chunks and dropping the overflow", async () => {
      // Audio arrives before the worklet is up (mic permission still
      // pending). The buffer is a bounded cushion, not a queue.
      //
      // This used to assert only `state === "speaking"` and `error === null`,
      // with a comment conceding that "nothing observable grows past the cap" —
      // and both held with the cap deleted, because the overflow path writes no
      // error and leaves the state alone. What IS observable is the drain: the
      // buffered chunks reach the playback worklet as `write` messages once it
      // comes up, so the retained set can be read back and named.
      const socket = connect();
      const OVERFLOW = 25;
      // Distinguishable chunks, so this can assert WHICH ones survived rather
      // than only how many — the cap keeps the first N and drops what follows,
      // which a length check alone cannot tell from the opposite policy.
      for (let i = 0; i < MAX_PREINIT_AUDIO_CHUNKS + OVERFLOW; i += 1) {
        socket.simulateMessage(new Uint8Array([i & 0xff, (i >> 8) & 0xff]).buffer);
      }
      expect(core.getSnapshot().state).toBe("speaking");

      await vi.waitFor(() => {
        expect(audio.workletNodes().some((n) => n.name === "playback-processor")).toBe(true);
      });
      const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");
      const written = playNode.port.posted
        .filter(
          (p): p is { event: "write"; buffer: Uint8Array } =>
            (p as { event?: string }).event === "write",
        )
        .map((w) => (w.buffer[0] as number) | ((w.buffer[1] as number) << 8));

      expect(written).toEqual(Array.from({ length: MAX_PREINIT_AUDIO_CHUNKS }, (_, i) => i));
      // …and the overflow is dropped silently: a bounded cushion, not an error.
      expect(core.getSnapshot().error).toBeNull();
    });
  });
  describe("no spurious snapshot churn", () => {
    it("an event that changes nothing notifies nobody", () => {
      // `updateState` always notifies, so a recovery path that "clears" an
      // error already null re-renders every consumer on every server event.
      const socket = connect();
      const listener = vi.fn();
      const unsubscribe = core.subscribe(listener);

      send(socket, { type: "speech.stopped" });

      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("a second audio chunk in the same turn does not re-announce speaking", () => {
      const audio = installAudioMocks();
      try {
        const socket = connect();
        socket.simulateMessage(new ArrayBuffer(8));
        expect(core.getSnapshot().state).toBe("speaking");

        const listener = vi.fn();
        const unsubscribe = core.subscribe(listener);
        socket.simulateMessage(new ArrayBuffer(8));

        expect(listener).not.toHaveBeenCalled();
        unsubscribe();
      } finally {
        audio.restore();
      }
    });
  });

  describe("reply_done vs cancelled", () => {
    it("reply_done leaves the live user transcript alone", () => {
      // `cancelled` clears it (a barge-in's partial is superseded); a reply
      // finishing normally must not, or captions for speech the user is still
      // producing vanish mid-utterance.
      const socket = connect();
      send(socket, { type: "user-transcript.updated", text: "and another thi" });
      send(socket, { type: "agent-transcript.updated", text: "Sure." });

      send(socket, { type: "reply.completed" });

      const snap = core.getSnapshot();
      expect(snap.userTranscript).toBe("and another thi");
      expect(snap.messages).toMatchObject([{ role: "assistant", content: "Sure." }]);
      expect(snap.state).toBe("listening");
    });
  });
});
