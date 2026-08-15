// Copyright 2026 the AAI authors. MIT license.
/**
 * Regression probes for late playback-drain completions landing on a session
 * that has already been torn down (found by `fuzz-session-core.test.ts` and
 * `fuzz-voiceio.test.ts`). A reply's drain resolves whenever the AudioContext
 * stops rendering, which a hang-up/fatal-error/reconnect causes — so without a
 * turn-boundary guard the continuation writes `state: "listening"` over a dead
 * session, and a stale turn's drain-stop settles the live turn early.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findWorkletNode, installAudioMocks } from "./_react-test-utils.ts";
import {
  type MockWebSocket,
  makeConfig,
  recordingWebSocketClass,
} from "./_session-core-test-utils.ts";
import { createSessionCore } from "./session-core.ts";
import { loadAudioModules } from "./session-core-audio-setup.ts";

function noop(): void {
  /* expected console output */
}

describe("late playback drain vs teardown", () => {
  let audio: ReturnType<typeof installAudioMocks>;
  let socket: MockWebSocket | null = null;
  const WS = recordingWebSocketClass((s) => {
    socket = s;
  });

  beforeEach(async () => {
    // Warm the memoized dynamic imports on real timers: module loading is real
    // I/O, which fake timers cannot pump.
    await loadAudioModules();
    vi.useFakeTimers();
    audio = installAudioMocks();
    socket = null;
    vi.spyOn(console, "warn").mockImplementation(noop);
  });
  afterEach(() => {
    audio.restore();
    vi.useRealTimers();
  });

  async function flush(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("disconnect() during a playback drain must not flip state back to listening", async () => {
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    await flush();
    expect(core.getSnapshot().recording).toBe(true);

    // Agent speaks: one audio chunk (creates the playback node) then audio_done,
    // so the core is awaiting the worklet's drain.
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await flush();
    expect(core.getSnapshot().state).toBe("speaking");

    // User hangs up mid-speech.
    core.disconnect();
    expect(core.getSnapshot().state).toBe("disconnected");

    // The pending done() settles once the closed context is noticed.
    await flush(2000);
    expect(core.getSnapshot().state).toBe("disconnected");
    expect(core.getSnapshot().recording).toBe(false);
  });

  it("end() during a playback drain must not flip state back to listening", async () => {
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    await flush();
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await flush();

    core.end();
    expect(core.getSnapshot().started).toBe(false);
    await flush(2000);
    expect(core.getSnapshot().state).toBe("disconnected");
  });

  it("fatal error during a playback drain must not flip state back to listening", async () => {
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    await flush();
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await flush();

    vi.spyOn(console, "error").mockImplementation(noop);
    socket?.simulateMessage(
      JSON.stringify({ type: "error.reported", code: "llm", message: "boom" }),
    );
    expect(core.getSnapshot().state).toBe("error");
    await flush(2000);
    expect(core.getSnapshot().state).toBe("error");
  });

  it("a worklet drain-stop in flight when flush() lands must not settle the next turn", async () => {
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    await flush();
    // Turn 1: chunk + audio_done → awaiting drain.
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await flush();
    const play = findWorkletNode(audio.workletNodes(), "playback-processor");

    // Barge-in: the client cancels (flush) and the server starts a new reply.
    core.cancel();
    await flush();
    expect(core.getSnapshot().state).toBe("listening");
    socket?.simulateMessage(new Uint8Array([5, 6, 7, 8]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await flush();
    expect(core.getSnapshot().state).toBe("speaking");

    // Turn 1's drain-stop was already in flight when the flush happened and
    // only now reaches the port: it must not settle turn 2's drain.
    play.port.simulateMessage({ event: "stop", reason: "done", stats: undefined });
    await flush();
    expect(core.getSnapshot().state).toBe("speaking");
  });
  it("a matching drain-stop settles the turn and returns to listening", async () => {
    // The happy path the guards above exist to protect: without it, "discard
    // every late completion" and "discard the right ones" look identical.
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    await flush();
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await flush();
    expect(core.getSnapshot().state).toBe("speaking");

    const play = findWorkletNode(audio.workletNodes(), "playback-processor");
    // The worklet echoes the turn id this turn's `done()` posted.
    play.port.simulateMessage({ event: "stop", reason: "done", turn: 1, stats: undefined });
    await flush();

    expect(core.getSnapshot().state).toBe("listening");
  });

  it("audio_done with no audio pipeline yet still returns to listening", async () => {
    // Greeting audio can arrive before the worklet is up; there is nothing to
    // wait on, so the transition happens optimistically.
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    // No config frame, so audio init has not run and voiceIO is absent.
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));

    expect(core.getSnapshot().state).toBe("listening");
  });
});
