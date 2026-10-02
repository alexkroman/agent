// Copyright 2026 the AAI authors. MIT license.
// The idle watchdog (`createIdleWatchdog`), as a session drives it: the window
// is re-armed only by conversation the TRANSPORT observed, and on expiry the
// client is told why before its socket is closed. Driven through
// `createSessionCore`, which is where the watchdog's re-arm points live.

import type { SessionEvent } from "@alexkroman1/aai";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import { makeAgentConfig, makeCore, makeSink } from "./_core-harness.ts";
import type { ServerSession } from "./core-types.ts";

describe("createSessionCore — idle timeout", () => {
  test("emits idle_timeout after agentConfig.idleTimeoutMs of no audio", async () => {
    vi.useFakeTimers();
    try {
      const { core, sink } = makeCore({
        agentConfig: makeAgentConfig({ name: "t", idleTimeoutMs: 1000 }),
      });
      await core.start();
      expect(sink.events.filter((e) => e.type === "session.timedOut")).toHaveLength(0);
      vi.advanceTimersByTime(1001);
      expect(sink.events.filter((e) => e.type === "session.timedOut")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  // Idle means "nobody is talking", not "the client stopped sending bytes".
  // The browser mic streams continuously (barge-in needs it open), so while
  // raw frames re-armed the timer a tab left open on a silent room pinned the
  // session — and on the platform its guest, whose own idle self-exit needs
  // the session count to reach zero.
  test("inbound audio frames do NOT reset the idle timer", async () => {
    vi.useFakeTimers();
    try {
      const { core, sink } = makeCore({
        agentConfig: makeAgentConfig({ name: "t", idleTimeoutMs: 1000 }),
      });
      await core.start();
      // A continuously-streaming silent mic: frames the whole way through.
      for (let t = 0; t < 1100; t += 20) {
        core.onAudio(new Uint8Array(640));
        vi.advanceTimersByTime(20);
      }
      expect(sink.events.filter((e) => e.type === "session.timedOut")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The transport is the one that can tell speech from silence, so it owns
  // the signal — and a client cannot fake it: to make STT report speech it
  // has to send audio that really contains some.
  test.each([
    ["speech the transport detected", (c: ServerSession) => c.report({ type: "speech.started" })],
    [
      "an interim user transcript",
      (c: ServerSession) => c.report({ type: "userTranscript.updated", text: "hel" }),
    ],
    [
      "a committed user turn",
      (c: ServerSession) => c.report({ type: "userTranscript.committed", text: "hello" }),
    ],
    ["the agent replying", (c: ServerSession) => c.onReplyStarted("r1")],
    ["agent audio", (c: ServerSession) => c.onAudioChunk(new Uint8Array([1]))],
    [
      "a tool call",
      (c: ServerSession) =>
        c.report({ type: "tool.called", toolCallId: "c1", toolName: "t", args: {} }),
    ],
  ])("%s resets the idle timer", async (_label, act) => {
    vi.useFakeTimers();
    try {
      const { core, sink } = makeCore({
        agentConfig: makeAgentConfig({ name: "t", idleTimeoutMs: 1000 }),
      });
      await core.start();
      vi.advanceTimersByTime(800);
      act(core);
      vi.advanceTimersByTime(800);
      expect(sink.events.filter((e) => e.type === "session.timedOut")).toHaveLength(0);
      vi.advanceTimersByTime(300);
      expect(sink.events.filter((e) => e.type === "session.timedOut")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  test("closes the client connection after emitting idle_timeout", async () => {
    // The event alone retires nothing: aai-ui routes idle_timeout to its
    // default branch and waits for the close handler to transition the
    // session. Without this the socket stays open, holding the session, its
    // provider sockets, and (on the platform) a Modal input slot.
    vi.useFakeTimers();
    try {
      const { core, sink } = makeCore({
        agentConfig: makeAgentConfig({ name: "t", idleTimeoutMs: 1000 }),
      });
      await core.start();
      vi.advanceTimersByTime(1001);
      expect(sink.events.filter((e) => e.type === "session.timedOut")).toHaveLength(1);
      expect(sink.closeReasons).toEqual(["idle timeout"]);
    } finally {
      vi.useRealTimers();
    }
  });
  test("emits session.timedOut before closing, so the client learns why", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const sink = makeSink();
      const tracking: ClientSink = {
        ...sink.sink,
        event: (e: SessionEvent) => {
          order.push(`event:${e.type}`);
          sink.sink.event(e);
        },
        close: (reason?: string) => {
          order.push("close");
          sink.sink.close?.(reason);
        },
      };
      const { core } = makeCore({
        client: tracking,
        agentConfig: makeAgentConfig({ name: "t", idleTimeoutMs: 1000 }),
      });
      await core.start();
      vi.advanceTimersByTime(1001);
      expect(order).toEqual(["event:session.timedOut", "close"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
