// Copyright 2026 the AAI authors. MIT license.
// wireSessionSocket lifecycle specs: close/error handling, onOpen/onClose/
// onSessionEnd/onSinkCreated callbacks, ClientSink behavior, start-failure
// paths, and session-ID resumption. Startup/CONFIG/frame-routing specs live
// in ws-handler.test.ts.

import { describe, expect, test, vi } from "vitest";
import type { ClientSink } from "../sdk/protocol.ts";
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

function parseFirstFrame(ws: MockWebSocket): Record<string, unknown> {
  return JSON.parse(ws.sent[0] as string);
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("wireSessionSocket lifecycle", () => {
  test("close handler calls session.stop", async () => {
    const core = makeMockCore();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    ws.close();

    await vi.waitFor(() => {
      expect(core.stop).toHaveBeenCalledOnce();
    });
  });

  test("error event is logged", () => {
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger,
    });

    const errEvent = new Event("error");
    Object.defineProperty(errEvent, "message", { value: "test error" });
    ws.dispatchEvent(errEvent);

    expect(logger.error).toHaveBeenCalledWith(
      "WebSocket error",
      expect.objectContaining({ error: "test error" }),
    );
  });

  test("generic error event logs default message", () => {
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger,
    });

    ws.dispatchEvent(new Event("error"));

    expect(logger.error).toHaveBeenCalledWith(
      "WebSocket error",
      expect.objectContaining({ error: "WebSocket error" }),
    );
  });

  test("onOpen callback is invoked when socket opens", () => {
    const onOpen = vi.fn();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      onOpen,
      logger: silentLogger,
    });

    expect(onOpen).toHaveBeenCalledOnce();
  });

  test("onClose callback is invoked when socket closes", () => {
    const onClose = vi.fn();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      onClose,
      logger: silentLogger,
    });

    ws.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("onSessionEnd is called with sessionId after session cleanup", async () => {
    const onSessionEnd = vi.fn();
    const ws = openSocket();
    const sessions = new Map<string, SessionCore>();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      onSessionEnd,
      logger: silentLogger,
    });

    expect(sessions.size).toBe(1);
    const sessionId = [...sessions.keys()][0] ?? "";

    ws.close();

    await vi.waitFor(() => {
      expect(onSessionEnd).toHaveBeenCalledOnce();
    });
    expect(onSessionEnd).toHaveBeenCalledWith(sessionId);
    expect(sessions.size).toBe(0);
  });

  test("onSinkCreated callback is invoked with sessionId and ClientSink", () => {
    const onSinkCreated = vi.fn();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      onSinkCreated,
      logger: silentLogger,
    });

    expect(onSinkCreated).toHaveBeenCalledOnce();
    expect(typeof onSinkCreated.mock.calls[0]?.[0]).toBe("string");
  });

  test("ClientSink.open reflects ws.readyState", () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(capturedClient.open).toBe(true);
    ws.readyState = MockWebSocket.CLOSED;
    expect(capturedClient.open).toBe(false);
  });

  test("ClientSink.playAudioChunk sends raw binary Uint8Array", () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    const chunk = new Uint8Array([10, 20, 30]);
    capturedClient.playAudioChunk(chunk);

    const binaryFrames = (ws.sent as unknown[]).filter((d) => d instanceof Uint8Array);
    expect(binaryFrames.length).toBeGreaterThanOrEqual(1);
    expect(binaryFrames[0]).toBe(chunk);
  });

  test("ClientSink.playAudioDone sends audio_done JSON text frame", () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    capturedClient.playAudioDone();

    const textFrames = (ws.sent as unknown[])
      .filter((d): d is string => typeof d === "string")
      .map((s) => JSON.parse(s));
    expect(textFrames.find((m) => m.type === "audio_done")).toBeDefined();
  });

  test("ClientSink tolerates ws.send throwing (closed socket)", () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    ws.send = () => {
      throw new Error("socket closed");
    };
    capturedClient.event({ type: "speech_started" });
    capturedClient.playAudioChunk(new Uint8Array([1]));
    capturedClient.playAudioDone();
  });

  test("close during start() does not double-stop or throw", async () => {
    const startGate = deferred();
    const core = makeMockCore({ start: vi.fn(() => startGate.promise) });
    const ws = openSocket();
    const sessions = new Map<string, SessionCore>();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    ws.close();
    startGate.resolve();

    await vi.waitFor(() => {
      expect(core.stop).toHaveBeenCalledOnce();
    });
  });

  test("start() failure removes session from map before close", async () => {
    const core = makeMockCore({ start: vi.fn(() => Promise.reject(new Error("boom"))) });
    const ws = openSocket();
    const sessions = new Map<string, SessionCore>();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });

    ws.close();
  });

  test("session.start() timeout triggers 'Session start failed'", async () => {
    const core = makeMockCore({
      start: vi.fn(
        () =>
          new Promise<void>(() => {
            /* never resolves */
          }),
      ),
    });
    const ws = openSocket();
    const sessions = new Map<string, SessionCore>();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
      sessionStartTimeoutMs: 50,
    });

    expect(sessions.size).toBe(1);

    await vi.waitFor(
      () => {
        expect(sessions.size).toBe(0);
      },
      { timeout: 500 },
    );

    expect(silentLogger.error).toHaveBeenCalledWith(
      "Session start failed",
      expect.objectContaining({ error: expect.stringContaining("timed out") }),
    );
  });

  test("waits for open event when readyState is not OPEN", () => {
    const core = makeMockCore();
    const ws = openSocket(MockWebSocket.CONNECTING);

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(core.start).not.toHaveBeenCalled();

    ws.readyState = MockWebSocket.OPEN;
    ws.dispatchEvent(new Event("open"));

    expect(core.start).toHaveBeenCalledOnce();
  });

  test("resumeFrom reuses old session ID instead of generating new UUID", () => {
    const sessions = new Map<string, SessionCore>();
    const ws = openSocket();
    let capturedId: string | undefined;

    wireSessionSocket(ws, {
      sessions,
      createSession: (sid) => {
        capturedId = sid;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "old-session-abc",
    });

    expect(capturedId).toBe("old-session-abc");
    expect(sessions.has("old-session-abc")).toBeTruthy();
  });

  test("CONFIG frame contains resumed session ID as sessionId", () => {
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "resume-id-123",
    });

    const msg = parseFirstFrame(ws);
    expect(msg.type).toBe("config");
    expect(msg.sessionId).toBe("resume-id-123");
  });

  test("without resumeFrom, generates a new UUID session ID", () => {
    const sessions = new Map<string, SessionCore>();
    const ws = openSocket();
    let capturedId: string | undefined;

    wireSessionSocket(ws, {
      sessions,
      createSession: (sid) => {
        capturedId = sid;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(capturedId).toBeDefined();
    expect(capturedId).not.toBe("");
    expect(capturedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
