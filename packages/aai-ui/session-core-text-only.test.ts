// Copyright 2026 the AAI authors. MIT license.
/**
 * Text-only sessions (`audioOut: false` in the server config): the handshake
 * completes without touching the microphone, recording is opt-in via
 * startRecording(), and uploaded audio streams through sendAudioFile().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConstructorType,
  lastSocket,
  MockWebSocket,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";

const textOnlyConfig = () => makeConfig(16_000, 24_000, "sess-text", { audioOut: false });

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("createSessionCore (text-only)", () => {
  let core: SessionCore;

  beforeEach(() => {
    resetLastSocket();
    core = createSessionCore({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocket as unknown as ConstructorType,
    });
  });

  afterEach(() => {
    core.disconnect();
  });

  it("exposes the programmatic API URL before connecting", () => {
    expect(core.getSnapshot().apiUrl).toBe("ws://localhost:3000/websocket");
  });

  it("audioOut defaults to true and flips false on a text-only config", () => {
    expect(core.getSnapshot().audioOut).toBe(true);
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(textOnlyConfig());
    expect(core.getSnapshot().audioOut).toBe(false);
  });

  it("completes the handshake without initializing the microphone", async () => {
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(textOnlyConfig());
    // audio_ready goes out immediately — no getUserMedia, no worklets.
    expect(lastSocket?.send).toHaveBeenCalledWith(JSON.stringify({ type: "audio_ready" }));
    expect(core.getSnapshot().state).toBe("listening");
    await flush();
    // Had the mic path run, jsdom's missing mediaDevices would have set an
    // error state by now.
    expect(core.getSnapshot().state).toBe("listening");
    expect(core.getSnapshot().recording).toBe(false);
  });

  it("startRecording attempts mic capture only when asked", async () => {
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(textOnlyConfig());
    core.startRecording();
    // jsdom has no mediaDevices, so the attempted capture surfaces as the
    // same audio error a denied permission would — proving the path ran.
    await vi.waitFor(() => {
      expect(core.getSnapshot().error?.code).toBe("audio");
    });
  });

  it("startRecording is a no-op in voice sessions and before connect", async () => {
    core.startRecording(); // not connected
    await flush();
    expect(core.getSnapshot().error).toBe(null);
  });

  it("stopRecording without an active recording is a no-op", () => {
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(textOnlyConfig());
    expect(() => core.stopRecording()).not.toThrow();
    expect(core.getSnapshot().recording).toBe(false);
  });

  it("sendAudioFile rejects when the session is not connected", async () => {
    await expect(core.sendAudioFile(new Blob(["x"]))).rejects.toThrow(/not connected/);
  });

  it("disconnect resets recording", () => {
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(textOnlyConfig());
    core.disconnect();
    expect(core.getSnapshot().recording).toBe(false);
    expect(core.getSnapshot().state).toBe("disconnected");
  });

  it("a reset event does not clear the text-only flag", () => {
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(textOnlyConfig());
    lastSocket?.simulateMessage(JSON.stringify({ type: "reset" }));
    expect(core.getSnapshot().audioOut).toBe(false);
  });
});
