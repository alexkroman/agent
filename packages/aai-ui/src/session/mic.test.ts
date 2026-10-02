// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * The caller's mic mute, through the real session: what a muted frame
 * becomes on the wire (silence of the same length, never nothing), and the
 * three things it must NOT do — send a command, touch the agent, or reset
 * with the connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AudioMockContext, findWorkletNode, installAudioMocks } from "../_react-test-utils.ts";
import {
  lastSocket,
  MockWebSocketConstructor,
  makeConfig,
  resetLastSocket,
} from "../_session-core-test-utils.ts";
import { createBrowserSession } from "./browser-session.ts";
import type { BrowserSession } from "./types.ts";

describe("BrowserSession mic mute", () => {
  let core: BrowserSession;
  let audio: AudioMockContext;

  beforeEach(() => {
    resetLastSocket();
    sessionStorage.clear();
    audio = installAudioMocks();
    core = createBrowserSession({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocketConstructor,
    });
  });

  afterEach(() => {
    core.disconnect();
  });

  /** Connect, handshake, and wait for the capture worklet to be wired. */
  async function live() {
    core.connect();
    const socket = lastSocket;
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    // A throw rather than an expect: this is a helper, and waitFor retries until it stops.
    await vi.waitFor(() => {
      const wired = audio
        .workletNodes()
        .some((n) => n.name === "capture-processor" && n.port.onmessage);
      if (!wired) throw new Error("capture worklet not wired yet");
    });
    const capture = findWorkletNode(audio.workletNodes(), "capture-processor");
    const chunk = (samples: number[]) =>
      capture.port.simulateMessage({ event: "chunk", buffer: new Int16Array(samples).buffer });
    const binary = () =>
      (socket?.send.mock.calls ?? [])
        .map((c) => c[0])
        .filter((frame): frame is ArrayBuffer => frame instanceof ArrayBuffer)
        .map((frame) => Array.from(new Int16Array(frame)));
    const json = () =>
      (socket?.send.mock.calls ?? [])
        .map((c) => c[0])
        .filter((frame): frame is string => typeof frame === "string");
    return { chunk, binary, json };
  }

  it("starts unmuted", () => {
    expect(core.getSnapshot().micMuted).toBe(false);
  });

  it("sends SILENCE of the same length while muted — never nothing", async () => {
    // The transcriber ends an automatic turn on silence it can measure; a
    // stream that simply stops gives it none, and loses its clock too.
    const { chunk, binary } = await live();
    chunk([100, -200, 300]);
    core.setMicMuted(true);
    chunk([400, 500, 600]);
    chunk([7, 8]);
    core.setMicMuted(false);
    chunk([9, 10, 11]);
    expect(binary()).toEqual([
      [100, -200, 300],
      [0, 0, 0],
      [0, 0],
      [9, 10, 11],
    ]);
  });

  it("is purely local: no command, no interruption, the mic stays live", async () => {
    const { json } = await live();
    const framesBefore = json().length;
    const before = core.getSnapshot();
    core.setMicMuted(true);
    const after = core.getSnapshot();
    expect(json()).toHaveLength(framesBefore);
    expect(after.state).toBe(before.state);
    // `recording` is the capture path, and it is still open (streaming silence).
    expect(after.recording).toBe(before.recording);
    expect(after.micMuted).toBe(true);
  });

  it("can be set before connecting, so a session opens already muted", async () => {
    core.setMicMuted(true);
    const { chunk, binary } = await live();
    chunk([1, 2]);
    expect(binary()).toEqual([[0, 0]]);
  });

  it("survives disconnect → connect, reset() and end(): it is UI state", async () => {
    core.setMicMuted(true);
    await live();
    core.disconnect();
    expect(core.getSnapshot().micMuted).toBe(true);
    core.connect();
    expect(core.getSnapshot().micMuted).toBe(true);
    core.reset();
    core.resetState();
    expect(core.getSnapshot().micMuted).toBe(true);
    core.end();
    expect(core.getSnapshot().micMuted).toBe(true);
  });

  it("muting twice notifies once", () => {
    let notified = 0;
    core.subscribe(() => notified++);
    core.setMicMuted(true);
    core.setMicMuted(true);
    expect(notified).toBe(1);
  });
});
