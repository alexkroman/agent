// Copyright 2026 the AAI authors. MIT license.
/**
 * Error reporting and terminal-state behavior of the session core, driven
 * over the injected MockWebSocket: socket errors surface as connection
 * errors, terminal closes preserve a fatal error (and retire non-fatal
 * banners), guards on cancel/reset/pre-aborted signals, and the fatal /
 * non-fatal audio failure paths (mic release vs. survivable banner).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AudioMockContext, installAudioMocks } from "./_react-test-utils.ts";
import {
  type ConstructorType,
  lastSocket,
  MockWebSocket,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createSessionCore } from "./session-core.ts";
import type { SessionCore } from "./session-core-types.ts";

const fatalError = () =>
  JSON.stringify({ type: "error", code: "internal", message: "provider died" });

describe("session-core error handling", () => {
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

  // ─── Socket error reporting ───────────────────────────────────────────────

  describe("socket error reporting", () => {
    it("a socket error followed by close reports a connection error", () => {
      core.connect();
      lastSocket?.simulateOpen();
      lastSocket?.simulateError();
      lastSocket?.simulateClose();
      const snap = core.getSnapshot();
      expect(snap.state).toBe("error");
      expect(snap.error).toEqual({ code: "connection", message: "WebSocket connection error" });
      expect(snap.running).toBe(false);
    });

    it("a clean close without a socket error reports no error", () => {
      core.connect();
      lastSocket?.simulateOpen();
      lastSocket?.simulateClose();
      const snap = core.getSnapshot();
      expect(snap.state).toBe("disconnected");
      expect(snap.error).toBe(null);
    });
  });

  // ─── Terminal close state ─────────────────────────────────────────────────

  describe("terminal close state", () => {
    let audio: { restore: () => void };

    beforeEach(() => {
      audio = installAudioMocks();
    });

    afterEach(() => {
      audio.restore();
    });

    it("a clean close retires a lingering non-fatal error banner", async () => {
      core.connect();
      lastSocket?.simulateOpen();
      lastSocket?.simulateMessage(makeConfig());
      await vi.waitFor(() => {
        expect(core.getSnapshot().recording).toBe(true);
      });
      lastSocket?.simulateMessage(
        JSON.stringify({ type: "error", code: "stt", message: "one turn failed", fatal: false }),
      );
      expect(core.getSnapshot().error?.code).toBe("stt");

      lastSocket?.simulateClose();
      const snap = core.getSnapshot();
      expect(snap.state).toBe("disconnected");
      expect(snap.error).toBe(null);
    });

    it("a close after a fatal error preserves the error state", async () => {
      core.connect();
      lastSocket?.simulateOpen();
      lastSocket?.simulateMessage(makeConfig());
      await vi.waitFor(() => {
        expect(core.getSnapshot().recording).toBe(true);
      });
      lastSocket?.simulateMessage(fatalError());
      expect(core.getSnapshot().state).toBe("error");

      lastSocket?.simulateClose();
      const snap = core.getSnapshot();
      // Not downgraded to "disconnected" — the user must still see why the
      // session ended.
      expect(snap.state).toBe("error");
      expect(snap.error).toEqual({ code: "internal", message: "provider died" });
      expect(snap.running).toBe(false);
    });
  });

  // ─── Pre-aborted signal ───────────────────────────────────────────────────

  it("connect with an already-aborted signal disconnects without opening a socket", () => {
    const controller = new AbortController();
    controller.abort();
    core.connect({ signal: controller.signal });
    expect(core.getSnapshot().state).toBe("disconnected");
    expect(lastSocket).toBeNull();
  });

  // ─── cancel guard ─────────────────────────────────────────────────────────

  describe("cancel guard", () => {
    it("cancel while disconnected leaves state untouched and sends nothing", () => {
      core.cancel();
      expect(core.getSnapshot().state).toBe("disconnected");
      expect(lastSocket).toBeNull();
    });

    it("cancel while still connecting leaves state untouched and sends nothing", () => {
      core.connect();
      // Socket exists but never opened (readyState CONNECTING).
      core.cancel();
      expect(core.getSnapshot().state).toBe("connecting");
      expect(lastSocket?.send).not.toHaveBeenCalled();
    });
  });

  // ─── reset on a closed socket ─────────────────────────────────────────────

  it("reset after a terminal close reconnects with running: true", () => {
    core.connect();
    lastSocket?.simulateOpen();
    const first = lastSocket;
    first?.simulateClose();
    expect(core.getSnapshot().state).toBe("disconnected");

    core.reset();
    const snap = core.getSnapshot();
    expect(snap.running).toBe(true);
    expect(snap.state).toBe("connecting");
    expect(lastSocket).not.toBe(first);
    expect(lastSocket).not.toBeNull();
  });

  // ─── Error-state chunk guard ──────────────────────────────────────────────

  it("a binary chunk arriving in a fatal error state does not flip to speaking", () => {
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(fatalError());
    expect(core.getSnapshot().state).toBe("error");

    lastSocket?.simulateMessage(new Uint8Array(320).buffer);
    expect(core.getSnapshot().state).toBe("error");
    expect(core.getSnapshot().error).not.toBe(null);
  });

  // ─── Recovery from a fatal error while the socket lives ──────────────────

  it("a server event after a fatal error recovers to listening", () => {
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(fatalError());
    expect(core.getSnapshot().state).toBe("error");

    // The socket is demonstrably alive — a server event proves the session
    // works, so the error state recovers to "listening", not "disconnected".
    lastSocket?.simulateMessage(JSON.stringify({ type: "agent_transcript", text: "still here" }));
    const snap = core.getSnapshot();
    expect(snap.state).toBe("listening");
    expect(snap.error).toBe(null);
  });

  // ─── Audio failure paths ──────────────────────────────────────────────────

  describe("audio failure paths", () => {
    let audio: AudioMockContext & { restore: () => void };

    beforeEach(() => {
      audio = installAudioMocks();
    });

    afterEach(() => {
      audio.restore();
    });

    it("a fatal error event releases the microphone", async () => {
      const track = {
        stopped: false,
        stop() {
          this.stopped = true;
        },
      };
      navigator.mediaDevices.getUserMedia = () =>
        Promise.resolve({ getTracks: () => [track] } as unknown as MediaStream);

      core.connect();
      lastSocket?.simulateOpen();
      lastSocket?.simulateMessage(makeConfig()); // voice session
      await vi.waitFor(() => {
        expect(core.getSnapshot().recording).toBe(true);
      });
      expect(track.stopped).toBe(false);

      lastSocket?.simulateMessage(fatalError());
      expect(core.getSnapshot().state).toBe("error");
      expect(core.getSnapshot().recording).toBe(false);
      // cleanupAudio closes the VoiceIO, which stops the mic tracks.
      await vi.waitFor(() => {
        expect(track.stopped).toBe(true);
      });
    });
  });
});
