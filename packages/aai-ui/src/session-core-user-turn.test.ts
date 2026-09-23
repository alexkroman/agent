// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser half of push-to-talk: the three frames `BrowserSession` sends,
 * and the two things it does locally rather than waiting a round trip for —
 * stopping the agent's audio on a press, and clearing the caption of a
 * discarded turn. What the server does with the frames is `aai-runtime`'s
 * `pipeline-manual-turn.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAudioMocks } from "./_react-test-utils.ts";
import {
  assertValidClientFrames,
  type MockWebSocket,
  makeConfig,
  recordingWebSocketClass,
} from "./_session-core-test-utils.ts";
import { createBrowserSession } from "./session-core.ts";
import { loadAudioModules } from "./session-core-audio-setup.ts";

function noop(): void {
  /* expected console output */
}

/** The `type` of every JSON frame the client sent, in order. */
function sentTypes(socket: MockWebSocket | null): string[] {
  return (socket?.send.mock.calls ?? [])
    .map((call) => call[0])
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => (JSON.parse(frame) as { type: string }).type)
    .filter((type) => type !== "audio_ready" && type !== "playback_progress");
}

describe("BrowserSession push-to-talk", () => {
  let audio: ReturnType<typeof installAudioMocks>;
  let socket: MockWebSocket | null = null;
  const WS = recordingWebSocketClass((s) => {
    socket = s;
  });

  beforeEach(async () => {
    await loadAudioModules();
    vi.useFakeTimers();
    audio = installAudioMocks();
    socket = null;
    sessionStorage.clear();
    vi.spyOn(console, "warn").mockImplementation(noop);
  });
  afterEach(() => {
    audio.restore();
    vi.useRealTimers();
  });

  async function live() {
    const core = createBrowserSession({ platformUrl: "https://host/agent/", WebSocket: WS });
    core.start();
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    await vi.advanceTimersByTimeAsync(0);
    return core;
  }

  it("sends one frame per edge, and nothing while disconnected", async () => {
    const idle = createBrowserSession({ platformUrl: "https://host/agent/", WebSocket: WS });
    expect(() => {
      idle.userTurn.start();
      idle.userTurn.commit();
      idle.userTurn.clear();
    }).not.toThrow();

    const core = await live();
    core.userTurn.start();
    core.userTurn.commit();
    core.userTurn.start();
    core.userTurn.clear();
    expect(sentTypes(socket)).toEqual([
      "user_turn_start",
      "user_turn_commit",
      "user_turn_start",
      "user_turn_clear",
    ]);
    assertValidClientFrames(socket);
    core.disconnect();
  });

  it("a press while the agent speaks stops it here, before the server answers", async () => {
    const core = await live();
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(core.getSnapshot().state).toBe("speaking");

    core.userTurn.start();
    expect(core.getSnapshot().state).toBe("listening");
    core.disconnect();
  });

  it("a press into silence leaves the state alone", async () => {
    const core = await live();
    const before = core.getSnapshot().state;
    core.userTurn.start();
    expect(core.getSnapshot().state).toBe(before);
    core.disconnect();
  });

  it("clearing a turn clears the caption it left behind", async () => {
    const core = await live();
    core.userTurn.start();
    socket?.simulateMessage(JSON.stringify({ type: "user-transcript.updated", text: "never mi" }));
    expect(core.getSnapshot().userTranscript).toBe("never mi");
    core.userTurn.clear();
    expect(core.getSnapshot().userTranscript).toBeNull();
    core.disconnect();
  });
});
