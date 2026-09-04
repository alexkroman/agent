// Copyright 2026 the AAI authors. MIT license.
/**
 * The audio path's failure and replay branches (session-core-audio-setup.ts).
 *
 * A voice session cannot function without the mic, so a bring-up failure has
 * to end the session visibly rather than leave it in a healthy-looking
 * "listening" state with nothing flowing. These cover that report, the
 * post-setup worklet crash that reaches it too, and the buffered-greeting
 * replay — the branches the happy-path suites never enter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crashWorklet, findWorkletNode, g, installAudioMocks } from "./_react-test-utils.ts";
import {
  type MockWebSocket,
  makeConfig,
  recordingWebSocketClass,
} from "./_session-core-test-utils.ts";
import { createSessionCore } from "./session-core.ts";
import { loadAudioModules } from "./session-core-audio-setup.ts";
import type { SessionCore } from "./session-core-types.ts";

/** `navigator.mediaDevices`, which installAudioMocks patches in place. */
function mediaDevices(): { getUserMedia: unknown } {
  return (g.navigator as { mediaDevices: { getUserMedia: unknown } }).mediaDevices;
}

describe("audio bring-up failures", () => {
  let audio: ReturnType<typeof installAudioMocks>;
  let socket: MockWebSocket | null = null;
  const WS = recordingWebSocketClass((s) => {
    socket = s;
  });

  beforeEach(async () => {
    // The dynamic imports are real I/O; warm the memo before faking anything.
    await loadAudioModules();
    audio = installAudioMocks();
    socket = null;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    audio.restore();
  });

  /** Start a session and deliver the config frame that kicks off audio init. */
  function connected(): SessionCore {
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    return core;
  }

  it("reports a denied microphone as a fatal audio error", async () => {
    const denied = new Error("Permission denied");
    mediaDevices().getUserMedia = () => Promise.reject(denied);

    const core = connected();
    await vi.waitFor(() => {
      expect(core.getSnapshot().state).toBe("error");
    });

    const snap = core.getSnapshot();
    // All four fields matter: a session that keeps `running`/`recording` set
    // shows a live mic indicator on a session that cannot hear anything.
    expect(snap.error).toEqual({
      code: "audio",
      message: expect.stringContaining("Microphone access failed"),
      // NOT the fatal latch, despite this test's name — which predates the
      // field and meant "the session is in `error` with the mic released".
      // `reportAudioFailure` dispatches `FAILED` on purpose: the socket may
      // well still be fine, so a later server frame may clear this banner.
      fatal: false,
    });
    expect(snap.error?.message).toContain("Permission denied");
    expect(snap.running).toBe(false);
    expect(snap.recording).toBe(false);
  });

  it("does not report a failure that lands after the session moved on", async () => {
    // A stale generation's rejection must not error a session that has
    // already reconnected (or hung up) — the failure belongs to a dead
    // connection nobody is watching.
    let reject: ((err: Error) => void) | undefined;
    mediaDevices().getUserMedia = () =>
      new Promise((_resolve, rej) => {
        reject = rej;
      });

    const core = connected();
    await vi.waitFor(() => {
      expect(reject).toBeDefined();
    });

    core.disconnect();
    reject?.(new Error("too late"));
    await Promise.resolve();

    expect(core.getSnapshot().state).toBe("disconnected");
    expect(core.getSnapshot().error).toBeNull();
  });

  it("surfaces a worklet crash after setup, releasing the audio path", async () => {
    // The socket is fine but the audio path is dead; staying in a
    // healthy-looking listening state would hide it forever.
    const core = connected();
    await vi.waitFor(() => {
      expect(core.getSnapshot().recording).toBe(true);
    });

    // `crashWorklet` rather than a local cast plus `?.()`: the cast lives at
    // one seam in `_react-test-utils.ts` (the escape-hatch ratchet counts every
    // copy), and it calls the handler UNCONDITIONALLY — so a build that stopped
    // installing one is a TypeError naming this line, where the optional call
    // was a silent no-op that left every assertion below passing on the
    // pre-crash snapshot.
    crashWorklet(findWorkletNode(audio.workletNodes(), "capture-processor"));

    const snap = core.getSnapshot();
    expect(snap.state).toBe("error");
    expect(snap.error?.code).toBe("audio");
    expect(snap.running).toBe(false);
    expect(snap.recording).toBe(false);
  });

  it("drops a mic frame the socket refuses, without killing the session", async () => {
    // A `send` can throw on a socket that is closing under us. The capture
    // worklet keeps streaming regardless, so the throw has to be swallowed
    // per frame — an escaping error would surface as an unhandled rejection
    // and take the session with it.
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const core = connected();
    await vi.waitFor(() => {
      expect(core.getSnapshot().recording).toBe(true);
    });

    socket?.send.mockImplementation(() => {
      throw new Error("socket closing");
    });
    const capture = findWorkletNode(audio.workletNodes(), "capture-processor");
    capture.port.simulateMessage({ event: "chunk", buffer: new Uint8Array([1, 2]).buffer });

    expect(debugSpy).toHaveBeenCalledWith("[aai-ui] sendAudio dropped: connection closed");
    // The session is untouched: still recording, still no error.
    expect(core.getSnapshot().recording).toBe(true);
    expect(core.getSnapshot().error).toBeNull();
  });
});

describe("buffered greeting replay", () => {
  let audio: ReturnType<typeof installAudioMocks>;
  let socket: MockWebSocket | null = null;
  const WS = recordingWebSocketClass((s) => {
    socket = s;
  });

  beforeEach(async () => {
    await loadAudioModules();
    audio = installAudioMocks();
    socket = null;
  });

  afterEach(() => {
    audio.restore();
  });

  it("replays a greeting whose audio_done beat the worklet", async () => {
    // A greeting can be fully sent — chunks AND `audio_done` — before the mic
    // permission resolves. Both halves have to survive: the buffered chunks
    // are enqueued on the new worklet, and the recorded done is replayed as a
    // drain wait rather than dropped, so a greeting shorter than the jitter
    // buffer still plays out.
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    // Both arrive before any microtask can advance the init pipeline.
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]).buffer);
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));

    await vi.waitFor(() => {
      expect(core.getSnapshot().recording).toBe(true);
    });

    const play = findWorkletNode(audio.workletNodes(), "playback-processor");
    const writes = play.port.posted.filter(
      (posted) => (posted as { event?: string }).event === "write",
    );
    expect(writes).toHaveLength(1);

    // The replayed done is a drain wait on the real worklet: its stop settles
    // cleanly rather than landing on a turn nobody is waiting for.
    play.port.simulateMessage({ event: "stop", reason: "done", turn: 1, stats: undefined });
    await vi.waitFor(() => {
      expect(core.getSnapshot().state).toBe("listening");
    });
  });

  it("goes straight to listening when nothing was buffered", async () => {
    const core = createSessionCore({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());

    await vi.waitFor(() => {
      expect(core.getSnapshot().state).toBe("listening");
    });
    expect(core.getSnapshot().recording).toBe(true);
  });
});
