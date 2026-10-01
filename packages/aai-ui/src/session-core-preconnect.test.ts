// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * Pre-connect audio through the real session: the mic opens on `connect()`,
 * what is captured before the `config` frame reaches the wire first and whole,
 * and the capture is released by every way a session ends before `config`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AudioMockContext,
  g,
  installAudioMocks,
  type MockAudioWorkletNode,
  tick,
} from "./_react-test-utils.ts";
import {
  lastSocket,
  MockWebSocketConstructor,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createBrowserSession } from "./session-core.ts";
import type { BrowserSession } from "./session-core-types.ts";
import { MIC_SEND_MAX_BUFFERED_BYTES } from "./types.ts";

describe("BrowserSession pre-connect audio", () => {
  let core: BrowserSession;
  let audio: AudioMockContext & { restore: () => void };
  let trackStops: ReturnType<typeof vi.fn>;
  let getUserMedia: ReturnType<typeof vi.fn<() => Promise<unknown>>>;

  beforeEach(() => {
    resetLastSocket();
    sessionStorage.clear();
    audio = installAudioMocks();
    trackStops = vi.fn();
    getUserMedia = vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve({ getTracks: () => [{ stop: trackStops }] }),
    );
    (g.navigator as { mediaDevices: { getUserMedia: unknown } }).mediaDevices.getUserMedia =
      getUserMedia;
  });

  afterEach(() => {
    core.disconnect();
    audio.restore();
  });

  function session(preConnectAudio?: boolean): BrowserSession {
    core = createBrowserSession({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocketConstructor,
      preConnectAudio,
    });
    return core;
  }

  const captureNodes = (): MockAudioWorkletNode[] =>
    audio.workletNodes().filter((n) => n.name === "capture-processor" && n.port.onmessage);

  /** The capture node the pre-connect path started, once it is wired. */
  async function preCapture(): Promise<MockAudioWorkletNode> {
    await vi.waitFor(() => {
      if (captureNodes().length === 0) throw new Error("pre-connect capture not wired yet");
    });
    return captureNodes()[0] as MockAudioWorkletNode;
  }

  const say = (node: MockAudioWorkletNode, value: number, samples = 4) =>
    node.port.simulateMessage({
      event: "chunk",
      buffer: new Int16Array(samples).fill(value).buffer,
    });

  /** The first sample of every binary frame sent, in order. */
  const sentAudio = () =>
    (lastSocket?.send.mock.calls ?? [])
      .map((c) => c[0])
      .filter((frame): frame is ArrayBuffer => frame instanceof ArrayBuffer)
      .map((frame) => new Int16Array(frame)[0]);

  async function configured(): Promise<void> {
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(makeConfig());
    await vi.waitFor(() => {
      if (!core.getSnapshot().recording) throw new Error("audio path not up yet");
    });
  }

  it("opens the mic on connect, before the server has configured anything", async () => {
    session().connect();
    await preCapture();
    expect(getUserMedia).toHaveBeenCalledOnce();
    // Nothing can be sent yet: no socket is open.
    expect(sentAudio()).toEqual([]);
  });

  it("sends what was said before config first, then the live stream — one mic grant", async () => {
    session().connect();
    const node = await preCapture();
    say(node, 1);
    say(node, 2);

    await configured();
    say(node, 3);

    expect(sentAudio()).toEqual([1, 2, 3]);
    expect(getUserMedia).toHaveBeenCalledOnce();
    // Adopted, not replaced: makeConfig's STT rate is the guessed 16 kHz.
    expect(captureNodes()).toHaveLength(1);
  });

  it("the burst passes the live stream's backpressure drop; live frames still honour it", async () => {
    session().connect();
    const node = await preCapture();
    say(node, 1);
    lastSocket?.simulateOpen();
    if (lastSocket) lastSocket.bufferedAmount = MIC_SEND_MAX_BUFFERED_BYTES + 1;
    lastSocket?.simulateMessage(makeConfig());
    await vi.waitFor(() => {
      if (!core.getSnapshot().recording) throw new Error("audio path not up yet");
    });
    say(node, 2);

    expect(sentAudio()).toEqual([1]);
  });

  it("a muted caller's buffered audio goes out as silence", async () => {
    session().connect();
    const node = await preCapture();
    say(node, 5);
    core.setMicMuted(true);
    await configured();
    expect(sentAudio()).toEqual([0]);
  });

  it("preConnectAudio: false asks for the mic only after config", async () => {
    session(false).connect();
    await tick();
    expect(getUserMedia).not.toHaveBeenCalled();
    await configured();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("a hang-up before config releases the microphone", async () => {
    session().connect();
    await preCapture();
    core.disconnect();
    await vi.waitFor(() => expect(trackStops).toHaveBeenCalled());
  });

  it("a denied pre-connect prompt falls back to the ordinary bring-up", async () => {
    getUserMedia.mockImplementationOnce(() => Promise.reject(new Error("NotAllowedError")));
    session().connect();
    await tick();
    await configured();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(core.getSnapshot().error).toBeNull();
  });
});
