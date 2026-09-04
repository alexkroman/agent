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

  /**
   * Advance fake time by `ms`, then settle whatever that scheduled.
   *
   * Named `advance`, not `flush`: `flush()` means a MICROTASK yield everywhere
   * else in the repo (`aai/host/_test-utils.ts`, and every spec importing it),
   * and this is a clock advance. Nothing was shadowed here — the export is not
   * imported in this file — but one name meaning two different waits is the
   * trap that made those specs define a local `flush` in the first place.
   */
  async function advance(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("disconnect() during a playback drain must not flip state back to listening", async () => {
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    await advance();
    expect(core.getSnapshot().recording).toBe(true);

    // Agent speaks: one audio chunk (creates the playback node) then audio_done,
    // so the core is awaiting the worklet's drain.
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await advance();
    expect(core.getSnapshot().state).toBe("speaking");

    // User hangs up mid-speech.
    core.disconnect();
    expect(core.getSnapshot().state).toBe("disconnected");

    // The pending done() settles once the closed context is noticed.
    await advance(2000);
    expect(core.getSnapshot().state).toBe("disconnected");
    expect(core.getSnapshot().recording).toBe(false);
  });

  it("end() during a playback drain must not flip state back to listening", async () => {
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    await advance();
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await advance();

    core.end();
    expect(core.getSnapshot().started).toBe(false);
    await advance(2000);
    expect(core.getSnapshot().state).toBe("disconnected");
  });

  it("fatal error during a playback drain must not flip state back to listening", async () => {
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    await advance();
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await advance();

    vi.spyOn(console, "error").mockImplementation(noop);
    socket?.simulateMessage(
      JSON.stringify({ type: "error.reported", code: "llm", message: "boom", fatal: true }),
    );
    expect(core.getSnapshot().state).toBe("error");
    await advance(2000);
    expect(core.getSnapshot().state).toBe("error");
  });

  /**
   * A stale drain-stop reaching the port after a barge-in has started turn 2.
   *
   * Both spellings are run, because the guard (`msg.turn !== pendingStopTurn`)
   * has to reject both and each pins a different way of getting it wrong. This
   * spec used to send only the id-LESS form while being named for turn 1's
   * stop: `undefined !== 2` discriminates a deleted guard, but it does not
   * model the message the real worklet posts, so narrowing the guard to "drop
   * only OLDER turns" would keep it green — and the happy-path sibling below,
   * which does pass `turn: 1`, would stay green too.
   */
  it.each([
    { label: "carrying turn 1's own id, as the worklet posts it", turn: 1 },
    { label: "carrying no id, as a worklet build predating the handshake does", turn: undefined },
  ])(
    "a drain-stop in flight when a barge-in lands must not settle the next turn ($label)",
    async ({ turn }) => {
      const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
      core.start();
      socket?.simulateOpen();
      socket?.simulateMessage(makeConfig());
      await advance();
      // Turn 1: chunk + audio_done → awaiting drain.
      socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
      socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
      await advance();
      const play = findWorkletNode(audio.workletNodes(), "playback-processor");

      // Barge-in: the client cancels (flush) and the server starts a new reply.
      core.cancel();
      await advance();
      expect(core.getSnapshot().state).toBe("listening");
      socket?.simulateMessage(new Uint8Array([5, 6, 7, 8]));
      socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
      await advance();
      expect(core.getSnapshot().state).toBe("speaking");

      // Turn 1's drain-stop was already in flight when the flush happened and
      // only now reaches the port: it must not settle turn 2's drain.
      play.port.simulateMessage({ event: "stop", reason: "done", turn, stats: undefined });
      await advance();
      expect(core.getSnapshot().state).toBe("speaking");
    },
  );
  it("a matching drain-stop settles the turn and returns to listening", async () => {
    // The happy path the guards above exist to protect: without it, "discard
    // every late completion" and "discard the right ones" look identical.
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    await advance();
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await advance();
    expect(core.getSnapshot().state).toBe("speaking");

    const play = findWorkletNode(audio.workletNodes(), "playback-processor");
    // The worklet echoes the turn id this turn's `done()` posted.
    play.port.simulateMessage({ event: "stop", reason: "done", turn: 1, stats: undefined });
    await advance();

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
