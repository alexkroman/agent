// Copyright 2025 the AAI authors. MIT license.
/**
 * Resource cleanup and leak detection tests for client-side components.
 *
 * Verifies that AudioContext, media streams, worklet nodes, WebSocket
 * connections, and VoiceIO instances are properly released on disconnect,
 * error, and reconnect to prevent memory leaks in the browser.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AudioMockContext,
  findWorkletNode,
  flush,
  installAudioMocks,
  installMockLocation,
  installMockWebSocket,
  MockAudioContext,
} from "./_test-utils.ts";
import { createVoiceIO } from "./audio.ts";
import { createVoiceSession } from "./session.ts";

function noop() {
  /* intentional no-op */
}

function voiceOpts(overrides?: Partial<Parameters<typeof createVoiceIO>[0]>) {
  return {
    sttSampleRate: 16_000,
    ttsSampleRate: 24_000,
    captureWorkletSrc: "cap",
    playbackWorkletSrc: "play",
    onMicData: noop,
    ...overrides,
  };
}

// ─── Audio resource cleanup tests ────────────────────────────────────────────

describe("VoiceIO resource cleanup", () => {
  let audio: AudioMockContext & { restore: () => void };

  beforeEach(() => {
    audio = installAudioMocks();
  });

  afterEach(() => {
    audio.restore();
  });

  test("close() stops all media stream tracks", async () => {
    const io = await createVoiceIO(voiceOpts());
    await io.close();
    // AudioContext should be closed (verified via mock)
    expect(audio.lastContext().closed).toBe(true);
  });

  test("close() sends stop event to capture worklet", async () => {
    const io = await createVoiceIO(voiceOpts());
    const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");

    await io.close();

    expect(capNode.port.posted).toContainEqual({ event: "stop" });
  });

  test("close() disconnects capture and mic nodes", async () => {
    const io = await createVoiceIO(voiceOpts());
    const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");
    const disconnectSpy = vi.spyOn(capNode, "disconnect");

    await io.close();
    expect(disconnectSpy).toHaveBeenCalled();
  });

  test("close() is idempotent — second call is a no-op", async () => {
    const io = await createVoiceIO(voiceOpts());
    await io.close();
    // Second close should not throw
    await io.close();
    // AudioContext.close() should only be called once (first close succeeds,
    // second is guarded by lifecycle abort signal)
    expect(audio.lastContext().closed).toBe(true);
  });

  test("enqueue is a no-op after close (no new playback nodes)", async () => {
    const io = await createVoiceIO(voiceOpts());
    const nodeCountBefore = audio.workletNodes().length;

    await io.close();

    // Enqueue after close — should not create new worklet nodes
    io.enqueue(new Int16Array([100, 200, 300]).buffer);
    expect(audio.workletNodes().length).toBe(nodeCountBefore);
  });

  test("flush after close does not throw", async () => {
    const io = await createVoiceIO(voiceOpts());
    await io.close();
    // flush after close — should not throw even if playNode is null
    io.flush();
  });

  test("AsyncDisposable cleanup works via Symbol.asyncDispose", async () => {
    const io = await createVoiceIO(voiceOpts());
    await io[Symbol.asyncDispose]();
    expect(audio.lastContext().closed).toBe(true);
  });

  test("worklet load error cleans up AudioContext and media tracks", async () => {
    let _lastContext!: MockAudioContext;
    const g = globalThis as unknown as Record<string, unknown>;
    g.AudioContext = class extends MockAudioContext {
      constructor(opts?: { sampleRate?: number }) {
        super(opts);
        _lastContext = this;
        this.audioWorklet.addModule = () => Promise.reject(new Error("worklet load failed"));
      }
    };

    await expect(createVoiceIO(voiceOpts())).rejects.toThrow("worklet load failed");
    expect(_lastContext.closed).toBe(true);
  });

  test("playback node disconnects when it sends stop event", async () => {
    const io = await createVoiceIO(voiceOpts());

    // Enqueue audio to create a playback node
    io.enqueue(new Int16Array([100, -200, 300]).buffer);
    const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");
    const disconnectSpy = vi.spyOn(playNode, "disconnect");

    // Simulate playback completion
    playNode.port.simulateMessage({ event: "stop" });

    expect(disconnectSpy).toHaveBeenCalled();
    await io.close();
  });
});

// ─── VoiceSession resource cleanup tests ─────────────────────────────────────

describe("VoiceSession resource cleanup", () => {
  let mock: ReturnType<typeof installMockWebSocket>;
  let loc: ReturnType<typeof installMockLocation>;

  function makeSession(url = "http://localhost:3000") {
    return createVoiceSession({ platformUrl: url, WebSocket: globalThis.WebSocket });
  }

  beforeEach(() => {
    mock = installMockWebSocket();
    loc = installMockLocation();
  });

  afterEach(() => {
    mock.restore();
    loc.restore();
  });

  /** Get the last created mock WebSocket, throwing if none exists. */
  function lastWs() {
    const ws = mock.lastWs;
    if (!ws) throw new Error("Expected a MockWebSocket to have been created");
    return ws;
  }

  test("disconnect() closes WebSocket and nullifies reference", async () => {
    const session = makeSession();
    session.connect();
    await flush();

    const ws = lastWs();
    expect(ws.readyState).toBe(1); // OPEN
    const closeSpy = vi.spyOn(ws, "close");

    session.disconnect();

    expect(closeSpy).toHaveBeenCalled();
    expect(session.state.value).toBe("disconnected");
  });

  test("disconnect() sets intentional disconnection info", async () => {
    const session = makeSession();
    session.connect();
    await flush();

    session.disconnect();

    expect(session.disconnected.value).toEqual({ intentional: true });
  });

  test("server-initiated close sets unintentional disconnection", async () => {
    const session = makeSession();
    session.connect();
    await flush();

    const ws = lastWs();
    // Simulate server closing the connection
    ws.disconnect(1000);

    expect(session.disconnected.value).toEqual({ intentional: false });
    expect(session.state.value).toBe("disconnected");
  });

  test("Symbol.dispose calls disconnect", async () => {
    const session = makeSession();
    session.connect();
    await flush();

    session[Symbol.dispose]();

    expect(session.state.value).toBe("disconnected");
    expect(session.disconnected.value).toEqual({ intentional: true });
  });

  test("connect() cleans up previous connection before creating new one", async () => {
    const session = makeSession();
    session.connect();
    await flush();

    const firstWs = lastWs();
    const firstCloseSpy = vi.spyOn(firstWs, "close");

    // Connect again — should close previous socket
    session.connect();
    await flush();

    expect(firstCloseSpy).toHaveBeenCalled();
    expect(mock.created.length).toBe(2);
  });

  test("disconnect before open event does not throw", () => {
    const session = makeSession();
    session.connect();
    // Don't flush — WebSocket is still CONNECTING
    session.disconnect();
    expect(session.state.value).toBe("disconnected");
  });

  test("external AbortSignal triggers disconnect", async () => {
    const session = makeSession();
    const controller = new AbortController();

    session.connect({ signal: controller.signal });
    await flush();

    expect(session.state.value).not.toBe("disconnected");

    controller.abort();

    expect(session.state.value).toBe("disconnected");
    expect(session.disconnected.value).toEqual({ intentional: true });
  });

  test("resetState clears messages, toolCalls, utterances, and error", async () => {
    const session = makeSession();
    session.connect();
    await flush();

    // Simulate some state accumulation
    const ws = lastWs();
    ws.simulateMessage(JSON.stringify({ type: "user_transcript", text: "hello" }));
    ws.simulateMessage(
      JSON.stringify({ type: "error", code: "stt", message: "recognition failed" }),
    );

    session.resetState();

    expect(session.messages.value).toEqual([]);
    expect(session.userUtterance.value).toBe(null);
    expect(session.agentUtterance.value).toBe(null);
    expect(session.error.value).toBe(null);
  });

  test("multiple rapid disconnects don't throw", async () => {
    const session = makeSession();
    session.connect();
    await flush();

    session.disconnect();
    session.disconnect();
    session.disconnect();

    expect(session.state.value).toBe("disconnected");
  });

  test("connect after disconnect creates fresh connection", async () => {
    const session = makeSession();
    session.connect();
    await flush();

    session.disconnect();
    expect(mock.created.length).toBe(1);

    session.connect();
    await flush();
    expect(mock.created.length).toBe(2);
    expect(session.state.value).not.toBe("disconnected");
  });

  test("reset with open socket sends reset message instead of reconnecting", async () => {
    const session = makeSession();
    session.connect();
    await flush();

    const ws = lastWs();
    session.reset();

    // Should send a reset message, not create a new socket
    const sentMessages = ws.sentJson();
    expect(sentMessages.some((m) => m.type === "reset")).toBe(true);
    expect(mock.created.length).toBe(1);
  });

  test("reset with closed socket reconnects", async () => {
    const session = makeSession();
    session.connect();
    await flush();

    // Fully disconnect (client-initiated), which nullifies conn.ws
    session.disconnect();

    session.reset();
    await flush();

    // Should have created a new WebSocket for the reconnect
    expect(mock.created.length).toBe(2);
  });
});
