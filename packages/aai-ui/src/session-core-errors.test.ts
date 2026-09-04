// Copyright 2026 the AAI authors. MIT license.
/**
 * Error reporting and terminal-state behavior of the session core, driven
 * over the injected MockWebSocket: socket errors surface as connection
 * errors, terminal closes preserve a fatal error (and retire non-fatal
 * banners), guards on cancel/reset/pre-aborted signals, and the fatal /
 * non-fatal audio failure paths (mic release vs. survivable banner).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AudioMockContext,
  fakeMediaStream,
  fakeTrack,
  installAudioMocks,
} from "./_react-test-utils.ts";
import {
  lastSocket,
  MockWebSocketConstructor,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createSessionCore } from "./session-core.ts";
import type { SessionCore } from "./session-core-types.ts";

const fatalError = () =>
  JSON.stringify({
    type: "error.reported",
    code: "internal",
    message: "provider died",
    fatal: true,
  });

describe("session-core error handling", () => {
  let core: SessionCore;

  beforeEach(() => {
    resetLastSocket();
    core = createSessionCore({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocketConstructor,
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
      expect(snap.error).toEqual({
        code: "connection",
        message: "WebSocket connection error",
        // `FAILED`: a dropped socket is retried, so the latch stays clear.
        fatal: false,
      });
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
        JSON.stringify({
          type: "error.reported",
          code: "stt",
          message: "one turn failed",
          fatal: false,
        }),
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
      expect(snap.error).toEqual({ code: "internal", message: "provider died", fatal: true });
      expect(snap.running).toBe(false);
    });

    it("the teardown frames that FOLLOW a fatal error do not wipe its banner", async () => {
      // The host tears the transport down on a fatal error, and tearing down
      // emits — `terminate()` calls `onCancelled()` right after `emitError`.
      // Read as evidence the session recovered, that one frame took the
      // message off the screen a few hundred ms after it appeared and left
      // the session claiming to listen. A missing provider key is the case
      // that matters: it is the error that says what to go and fix.
      core.connect();
      lastSocket?.simulateOpen();
      lastSocket?.simulateMessage(makeConfig());
      await vi.waitFor(() => {
        expect(core.getSnapshot().recording).toBe(true);
      });
      lastSocket?.simulateMessage(
        JSON.stringify({
          type: "error.reported",
          code: "tts",
          message: "Cartesia TTS: missing API key. Set CARTESIA_API_KEY in the agent env.",
          fatal: true,
        }),
      );
      lastSocket?.simulateMessage(JSON.stringify({ type: "reply.cancelled" }));
      const snap = core.getSnapshot();
      expect(snap.state).toBe("error");
      expect(snap.error?.message).toContain("CARTESIA_API_KEY");
    });

    it("a fresh handshake supersedes it — a reconnected session is not stuck on it", async () => {
      // The latch is per CONNECTION: a `config` frame is a live session, so
      // whatever ended the last one must not pin a banner over this one.
      core.connect();
      lastSocket?.simulateOpen();
      lastSocket?.simulateMessage(makeConfig());
      await vi.waitFor(() => {
        expect(core.getSnapshot().recording).toBe(true);
      });
      lastSocket?.simulateMessage(fatalError());
      expect(core.getSnapshot().state).toBe("error");

      lastSocket?.simulateMessage(makeConfig());
      lastSocket?.simulateMessage(JSON.stringify({ type: "reply.cancelled" }));
      const snap = core.getSnapshot();
      expect(snap.state).toBe("listening");
      expect(snap.error).toBe(null);
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

  it("a server event after a fatal error does NOT recover the session", () => {
    // A live socket is not a live session. Every fatal path in the host tears
    // the transport down and keeps relaying whatever is already in flight, so
    // "a frame arrived" is not evidence the failure was survived — treating
    // it as evidence produced a session that looked live and was deaf.
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(fatalError());
    expect(core.getSnapshot().state).toBe("error");

    lastSocket?.simulateMessage(
      JSON.stringify({ type: "agent-transcript.updated", text: "still here" }),
    );
    const snap = core.getSnapshot();
    expect(snap.state).toBe("error");
    expect(snap.error).toEqual({ code: "internal", message: "provider died", fatal: true });
  });

  it("a server event after a NON-fatal error still retires its banner", () => {
    // The other half of the rule, and the case the recovery was written for:
    // the server kept running, so later activity clears the banner.
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(
      JSON.stringify({
        type: "error.reported",
        code: "stt",
        message: "one turn failed",
        fatal: false,
      }),
    );
    expect(core.getSnapshot().error?.code).toBe("stt");

    lastSocket?.simulateMessage(
      JSON.stringify({ type: "agent-transcript.updated", text: "still here" }),
    );
    expect(core.getSnapshot().error).toBe(null);
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
      const track = fakeTrack();
      navigator.mediaDevices.getUserMedia = () => Promise.resolve(fakeMediaStream(track));

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
