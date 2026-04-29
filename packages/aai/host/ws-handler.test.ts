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

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

    const startGate = deferred();
    const core = makeMockCore({ start: vi.fn(() => startGate.promise) });
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
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
      sessions: new Map(),
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
    const sessions = new Map<string, SessionCore>();
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
    const sessions = new Map<string, SessionCore>();
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
      sessions: new Map(),
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
      sessions: new Map(),
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
      sessions: new Map(),
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
      sessions: new Map(),
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

  test("audio_ready JSON text frame routes to session.onAudioReady", async () => {
    const core = makeMockCore();
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
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
      sessions: new Map(),
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
      sessions: new Map(),
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
      sessions: new Map(),
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
      sessions: new Map(),
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
      sessions: new Map(),
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
    const startGate = deferred();
    const core = makeMockCore({ start: vi.fn(() => startGate.promise) });
    const ws = openSocket();
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
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

  test("messages before session is created (no open yet) are ignored", () => {
    const ws = openSocket(MockWebSocket.CONNECTING);

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    simulateTextFrame(ws, JSON.stringify({ type: "audio_ready" }));
  });

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
