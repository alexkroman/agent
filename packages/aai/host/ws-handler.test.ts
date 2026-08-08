// Copyright 2026 the AAI authors. MIT license.
// wireSessionSocket startup, CONFIG frame, and client-frame routing specs.
// Lifecycle/callback/ClientSink specs live in ws-handler-lifecycle.test.ts.

import { describe, expect, test, vi } from "vitest";
import { createOwnedMap } from "../sdk/owned-map.ts";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeLogger, makeMockCore, silentLogger } from "./_test-utils.ts";
import type { SessionCore } from "./session-core.ts";
import { wireSessionSocket } from "./ws-handler.ts";

const defaultConfig = { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 };

function openSocket(readyState: number = MockWebSocket.OPEN): MockWebSocket {
  const ws = new MockWebSocket("ws://test");
  ws.readyState = readyState;
  return ws;
}

function simulateBinaryFrame(ws: MockWebSocket, frame: Uint8Array): void {
  ws.dispatchEvent(new MessageEvent("message", { data: frame }));
}

function simulateTextFrame(ws: MockWebSocket, text: string): void {
  ws.dispatchEvent(new MessageEvent("message", { data: text }));
}

async function waitForSessionReady(logger: { info: ReturnType<typeof vi.fn> }): Promise<void> {
  await vi.waitFor(() => {
    const calls = logger.info.mock.calls.map((c: unknown[]) => c[0]);
    if (!calls.includes("Session ready")) throw new Error("Session not ready yet");
  });
}

function parseFirstFrame(ws: MockWebSocket): Record<string, unknown> {
  return JSON.parse(ws.sent[0] as string);
}

describe("wireSessionSocket", () => {
  test("'Session ready' is not logged until session.start() resolves", async () => {
    const logs: string[] = [];
    const logger = {
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      debug: (msg: string) => logs.push(msg),
    };

    const startGate = Promise.withResolvers<void>();
    const core = makeMockCore({ start: vi.fn(() => startGate.promise) });
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    expect(core.start).toHaveBeenCalled();
    expect(logs).toContain("Session connected");
    expect(logs).not.toContain("Session ready");

    startGate.resolve();
    await vi.waitFor(() => {
      expect(logs).toContain("Session ready");
    });
  });

  test("logs 'Session start failed' when start() rejects", async () => {
    const logs: { msg: string; meta: Record<string, unknown> | undefined }[] = [];
    const record = (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta });
    const logger = { info: record, warn: record, error: record, debug: record };

    const core = makeMockCore({ start: vi.fn(() => Promise.reject(new Error("boom"))) });
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    await vi.waitFor(() => {
      expect(logs).toContainEqual(expect.objectContaining({ msg: "Session start failed" }));
    });
    expect(logs.map((l) => l.msg)).not.toContain("Session ready");
  });

  test("session is added to sessions map on open", () => {
    const sessions = createOwnedMap<string, SessionCore>();
    const core = makeMockCore();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => core,
      readyConfig: defaultConfig,
    });

    expect(sessions.size).toBe(1);
    expect([...sessions.values()][0]).toBe(core);
  });

  test("session is removed from sessions map on close", async () => {
    const sessions = createOwnedMap<string, SessionCore>();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
    });

    expect(sessions.size).toBe(1);
    ws.close();

    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });
  });

  test("sends CONFIG JSON frame as first message on open", () => {
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
    expect(typeof ws.sent[0]).toBe("string");
    expect(parseFirstFrame(ws).type).toBe("config");
  });

  test("CONFIG frame contains correct sampleRate and ttsSampleRate", () => {
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    const msg = parseFirstFrame(ws);
    expect(msg.type).toBe("config");
    expect(msg.audioFormat).toBe("pcm16");
    expect(msg.sampleRate).toBe(16_000);
    expect(msg.ttsSampleRate).toBe(24_000);
  });

  test("CONFIG frame includes the session ID as sessionId", () => {
    const ws = openSocket();
    let capturedId: string | undefined;

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: (sid) => {
        capturedId = sid;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    const msg = parseFirstFrame(ws);
    expect(msg.type).toBe("config");
    expect(msg.sessionId).toBeTruthy();
    expect(msg.sessionId).toBe(capturedId);
  });

  test("raw binary Uint8Array routes to session.onAudio", async () => {
    const core = makeMockCore();
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    const pcm = new Uint8Array([1, 2, 3, 4]);
    simulateBinaryFrame(ws, pcm);

    expect(core.onAudio).toHaveBeenCalledOnce();
    const passed = (core.onAudio as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(passed).toBeInstanceOf(Uint8Array);
  });

  // A zero-length frame is not audio. Forwarded, it reached the transport
  // (the S2S service answers `Missing 'audio' field`, which the client sees
  // as an `internal` error) and — worse — re-armed the idle timer, so a
  // client sending empty frames on a timer held its session, and the guest's
  // whole sandbox, open forever at no bandwidth cost.
  test("an empty binary frame is dropped, not treated as audio", async () => {
    const core = makeMockCore();
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    simulateBinaryFrame(ws, new Uint8Array(0));
    expect(core.onAudio).not.toHaveBeenCalled();

    // A frame with actual samples still gets through.
    simulateBinaryFrame(ws, new Uint8Array([1, 2]));
    expect(core.onAudio).toHaveBeenCalledOnce();
  });

  test("audio_ready JSON text frame routes to session.onAudioReady", async () => {
    const core = makeMockCore();
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);
    simulateTextFrame(ws, JSON.stringify({ type: "audio_ready" }));
    expect(core.onAudioReady).toHaveBeenCalledOnce();
  });

  test("cancel JSON text frame routes to session.onCancel", async () => {
    const core = makeMockCore();
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);
    simulateTextFrame(ws, JSON.stringify({ type: "cancel" }));
    expect(core.onCancel).toHaveBeenCalledOnce();
  });

  test("reset JSON text frame routes to session.onReset", async () => {
    const core = makeMockCore();
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);
    simulateTextFrame(ws, JSON.stringify({ type: "reset" }));
    expect(core.onReset).toHaveBeenCalledOnce();
  });

  test("history JSON text frame routes to session.onHistory with decoded messages", async () => {
    const core = makeMockCore();
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there" },
    ];
    simulateTextFrame(ws, JSON.stringify({ type: "history", messages }));
    expect(core.onHistory).toHaveBeenCalledOnce();
    const passed = (core.onHistory as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(passed).toEqual(messages);
  });

  test("invalid JSON text frame is dropped with warning, session not closed", async () => {
    const core = makeMockCore();
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    simulateTextFrame(ws, "this is not json{{{");
    expect(logger.warn).toHaveBeenCalledWith("ws: invalid JSON; dropping", expect.any(Object));
    expect(core.onAudioReady).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
  });

  test("unknown client message type is silently dropped", async () => {
    const core = makeMockCore();
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    // Valid envelope but unknown type — lenientParse returns ok:false, malformed:false; must NOT warn (rolling-upgrade tolerance)
    simulateTextFrame(ws, JSON.stringify({ type: "some_future_message_type" }));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(core.onAudioReady).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
  });

  test("frames before session is ready are buffered and replayed after start()", async () => {
    const startGate = Promise.withResolvers<void>();
    const core = makeMockCore({ start: vi.fn(() => startGate.promise) });
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    simulateTextFrame(ws, JSON.stringify({ type: "cancel" }));
    expect(core.onCancel).not.toHaveBeenCalled();

    startGate.resolve();
    await waitForSessionReady(logger);

    expect(core.onCancel).toHaveBeenCalledOnce();
  });

  test("pre-ready binary frames are byte-budgeted, not capped at the JSON message count", async () => {
    const startGate = Promise.withResolvers<void>();
    const core = makeMockCore({ start: vi.fn(() => startGate.promise) });
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    // Far more binary frames than the JSON count cap (100) — a whole file
    // upload arriving before session.start() resolves must survive intact.
    const frames = 300;
    for (let i = 0; i < frames; i++) {
      simulateBinaryFrame(ws, new Uint8Array(1024));
    }
    expect(logger.warn).not.toHaveBeenCalled();

    startGate.resolve();
    await waitForSessionReady(logger);
    expect(core.onAudio).toHaveBeenCalledTimes(frames);
  });

  test("pre-ready binary frames past the byte budget are dropped with a warning", async () => {
    const startGate = Promise.withResolvers<void>();
    const core = makeMockCore({ start: vi.fn(() => startGate.promise) });
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    // Budget is MAX_WS_PAYLOAD_BYTES = 1 MiB; fill it with 256 KiB frames,
    // then one more must be dropped (and logged).
    for (let i = 0; i < 4; i++) {
      simulateBinaryFrame(ws, new Uint8Array(256 * 1024));
    }
    expect(logger.warn).not.toHaveBeenCalled();
    simulateBinaryFrame(ws, new Uint8Array(256 * 1024));
    expect(logger.warn).toHaveBeenCalledWith(
      "ws: pre-ready message buffer full; dropping frame",
      expect.any(Object),
    );

    startGate.resolve();
    await waitForSessionReady(logger);
    expect(core.onAudio).toHaveBeenCalledTimes(4);
  });

  test("messages before session is created (no open yet) are ignored", () => {
    const ws = openSocket(MockWebSocket.CONNECTING);
    const core = makeMockCore();
    const createSession = vi.fn(() => core);

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    simulateTextFrame(ws, JSON.stringify({ type: "audio_ready" }));

    // "Ignored" has to be asserted against something. A frame arriving before
    // 'open' must neither conjure a session nor reach one: not-throwing is
    // what this used to check, and it would hold just as well if the frame
    // were being dispatched into a half-built session.
    expect(createSession).not.toHaveBeenCalled();
    expect(core.onAudioReady).not.toHaveBeenCalled();
    expect(ws.sent).toEqual([]);
  });
});
