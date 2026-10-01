// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser half of push-to-talk: the three frames `BrowserSession` sends,
 * and the two things it does locally rather than waiting a round trip for —
 * stopping the agent's audio on a press, and clearing the caption of a
 * discarded turn. What the server does with the frames is `aai-runtime`'s
 * `aai-runtime/src/transports/pipeline/speech/manual-turn.test.ts`.
 *
 * And the typed turn, `sendText`, which shares the local interruption: the
 * frame it sends, and the echo it deliberately does NOT make.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAudioMocks } from "../_react-test-utils.ts";
import {
  assertValidClientFrames,
  type MockWebSocket,
  makeConfig,
  recordingWebSocketClass,
} from "../_session-core-test-utils.ts";
import { loadAudioModules } from "./audio-setup.ts";
import { createBrowserSession } from "./browser-session.ts";

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
    socket?.simulateMessage(JSON.stringify({ type: "userTranscript.updated", text: "never mi" }));
    expect(core.getSnapshot().userTranscript).toBe("never mi");
    core.userTurn.clear();
    expect(core.getSnapshot().userTranscript).toBeNull();
    core.disconnect();
  });
});

describe("BrowserSession sendText", () => {
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

  /** Every `user_text` frame the client sent, parsed. */
  function sentText(): unknown[] {
    return (socket?.send.mock.calls ?? [])
      .map((call) => call[0])
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame) as { type: string })
      .filter((frame) => frame.type === "user_text");
  }

  it("sends one trimmed `user_text` frame, and nothing for an empty message", async () => {
    const core = await live();
    core.sendText("  what's the weather \n");
    core.sendText("");
    core.sendText("   ");
    expect(sentText()).toEqual([{ type: "user_text", text: "what's the weather" }]);
    assertValidClientFrames(socket);
    core.disconnect();
  });

  it("sends nothing while disconnected, and does not throw", () => {
    const idle = createBrowserSession({ platformUrl: "https://host/agent/", WebSocket: WS });
    expect(() => idle.sendText("hello")).not.toThrow();
    expect(socket).toBeNull();
  });

  it("does not echo the message into `messages` — the server's committed turn does", async () => {
    // One row, not two: the row comes from the same `userTranscript.committed`
    // a spoken turn produces, which is also what a resume replays.
    const core = await live();
    core.sendText("book a table");
    expect(core.getSnapshot().messages).toEqual([]);

    socket?.simulateMessage(
      JSON.stringify({ type: "userTranscript.committed", text: "book a table" }),
    );
    expect(core.getSnapshot().messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "book a table" },
    ]);
    core.disconnect();
  });

  it("typing over the agent stops it here, before the server answers", async () => {
    const core = await live();
    socket?.simulateMessage(new Uint8Array([1, 2, 3, 4]));
    socket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(core.getSnapshot().state).toBe("speaking");

    core.sendText("stop, different question");
    expect(core.getSnapshot().state).toBe("listening");
    core.disconnect();
  });

  it("a message into silence leaves the state alone", async () => {
    const core = await live();
    const before = core.getSnapshot().state;
    core.sendText("hi");
    expect(core.getSnapshot().state).toBe(before);
    core.disconnect();
  });

  describe("with `{ connect: true }`", () => {
    const idle = () => createBrowserSession({ platformUrl: "https://host/agent/", WebSocket: WS });
    const configure = async () => {
      socket?.simulateOpen();
      socket?.simulateMessage(makeConfig());
      await vi.advanceTimersByTimeAsync(0);
    };

    it("opens an idle session and sends once it is configured, in the order typed", async () => {
      const core = idle();
      core.sendText("first", { connect: true });
      core.sendText("second");
      expect(core.getSnapshot()).toMatchObject({ started: true, running: true });
      socket?.simulateOpen();
      // An open socket is not yet a session: nothing goes before `config`.
      expect(sentText()).toEqual([]);
      socket?.simulateMessage(makeConfig());
      await vi.advanceTimersByTimeAsync(0);
      expect(sentText()).toEqual([
        { type: "user_text", text: "first" },
        { type: "user_text", text: "second" },
      ]);
      core.sendText("third", { connect: true });
      expect(sentText()).toHaveLength(3);
      core.disconnect();
    });

    it("after a hang-up, RESUMES the session rather than starting a new one", async () => {
      const core = await live();
      core.disconnect();
      expect(core.getSnapshot()).toMatchObject({ started: true, running: false });
      core.sendText("still there?", { connect: true });
      expect(core.getSnapshot().running).toBe(true);
      expect(socket?.url).toContain("sessionId=sess-123");
      await configure();
      expect(sentText()).toEqual([{ type: "user_text", text: "still there?" }]);
      core.disconnect();
    });

    it("drops what was waiting when the session stops before it is up", async () => {
      const core = idle();
      core.sendText("never answered", { connect: true });
      core.disconnect();
      core.start();
      await configure();
      expect(sentText()).toEqual([]);
      core.disconnect();
    });

    it("an empty message neither queues nor opens anything", () => {
      const core = idle();
      core.sendText("   ", { connect: true });
      expect(core.getSnapshot().running).toBe(false);
      expect(socket).toBeNull();
    });
  });
});
