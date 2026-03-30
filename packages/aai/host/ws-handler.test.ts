import { describe, expect, test, vi } from "vitest";
import type { ClientSink } from "../isolate/protocol.ts";
import { MockWebSocket } from "./_mock-ws.ts";
import type { Session } from "./session.ts";
import { wireSessionSocket } from "./ws-handler.ts";

function makeStubSession(startDelay?: number): Session {
  return {
    start: vi.fn(() =>
      startDelay ? new Promise<void>((r) => setTimeout(r, startDelay)) : Promise.resolve(),
    ),
    stop: vi.fn(() => Promise.resolve()),
    onAudio: vi.fn(),
    onAudioReady: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
    onHistory: vi.fn(),
    waitForTurn: vi.fn(() => Promise.resolve()),
  };
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Wait until wireSessionSocket has fully initialized (sessionReady = true). */
async function waitForSessionReady(logger: { info: ReturnType<typeof vi.fn> }): Promise<void> {
  await vi.waitFor(() => {
    const calls = logger.info.mock.calls.map((c: unknown[]) => c[0]);
    if (!calls.includes("Session ready")) throw new Error("Session not ready yet");
  });
}

const defaultConfig = { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 };

describe("wireSessionSocket", () => {
  test("'Session ready' is not logged until session.start() resolves", async () => {
    const logs: string[] = [];
    const logger = {
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      debug: (msg: string) => logs.push(msg),
    };

    let resolveStart!: () => void;
    const session = makeStubSession();
    session.start = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveStart = r;
        }),
    );

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger,
    });

    expect(session.start).toHaveBeenCalled();
    expect(logs).toContain("Session connected");
    expect(logs).not.toContain("Session ready");

    resolveStart();
    await vi.waitFor(() => {
      expect(logs).toContain("Session ready");
    });
  });

  test("logs 'Session start failed' when start() rejects", async () => {
    const logs: { msg: string; meta: Record<string, unknown> | undefined }[] = [];
    const logger = {
      info: (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta }),
      warn: (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta }),
      error: (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta }),
      debug: (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta }),
    };

    const session = makeStubSession();
    session.start = vi.fn(() => Promise.reject(new Error("boom")));

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger,
    });

    await vi.waitFor(() => {
      expect(logs.some((l) => l.msg === "Session start failed")).toBe(true);
    });
    expect(logs.every((l) => l.msg !== "Session ready")).toBe(true);
  });

  test("session is added to sessions map on open", () => {
    const sessions = new Map<string, Session>();
    const session = makeStubSession();

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions,
      createSession: () => session,
      readyConfig: defaultConfig,
    });

    expect(sessions.size).toBe(1);
    expect([...sessions.values()][0]).toBe(session);
  });

  test("session is removed from sessions map on close", async () => {
    const sessions = new Map<string, Session>();
    const session = makeStubSession();

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions,
      createSession: () => session,
      readyConfig: defaultConfig,
    });

    expect(sessions.size).toBe(1);
    ws.close();

    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });
  });

  test("sends config as first message on open", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeStubSession(),
      readyConfig: defaultConfig,
    });

    const sent = ws.sentJson();
    expect(sent[0]).toMatchObject({ type: "config", ...defaultConfig });
  });

  // ─── Binary audio handling ──────────────────────────────────────────────

  test("Uint8Array binary data is forwarded to session.onAudio", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    const audio = new Uint8Array([1, 2, 3, 4]);
    ws.simulateMessage(audio.buffer);

    expect(session.onAudio).toHaveBeenCalledOnce();
    const passed = (session.onAudio as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(passed).toBeInstanceOf(Uint8Array);
  });

  test("ArrayBuffer data is forwarded to session.onAudio", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    const buf = new ArrayBuffer(4);
    ws.simulateMessage(buf);

    expect(session.onAudio).toHaveBeenCalledOnce();
  });

  // ─── Text message handling ──────────────────────────────────────────────

  test("audio_ready message calls session.onAudioReady", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    ws.simulateMessage(JSON.stringify({ type: "audio_ready" }));
    expect(session.onAudioReady).toHaveBeenCalledOnce();
  });

  test("cancel message calls session.onCancel", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    ws.simulateMessage(JSON.stringify({ type: "cancel" }));
    expect(session.onCancel).toHaveBeenCalledOnce();
  });

  test("reset message calls session.onReset", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    ws.simulateMessage(JSON.stringify({ type: "reset" }));
    expect(session.onReset).toHaveBeenCalledOnce();
  });

  test("history message calls session.onHistory", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi" },
    ];
    ws.simulateMessage(JSON.stringify({ type: "history", messages }));
    expect(session.onHistory).toHaveBeenCalledWith(messages);
  });

  test("invalid JSON is logged and ignored", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    ws.simulateMessage("not-json{{{");
    expect(logger.warn).toHaveBeenCalledWith("Invalid JSON from client", expect.any(Object));
  });

  test("invalid message schema is logged and ignored", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    ws.simulateMessage(JSON.stringify({ type: "unknown_type" }));
    expect(logger.warn).toHaveBeenCalledWith("Invalid client message", expect.any(Object));
  });

  // ─── ClientSink (indirect testing via createSession capture) ────────────

  test("ClientSink.event sends JSON text via ws.send", () => {
    let capturedClient!: ClientSink;
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeStubSession();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    capturedClient.event({ type: "speech_started" });
    const sentStrings = ws.sent.filter((d): d is string => typeof d === "string");
    expect(sentStrings.some((s) => s.includes('"speech_started"'))).toBe(true);
  });

  test("ClientSink.playAudioChunk sends binary data", () => {
    let capturedClient!: ClientSink;
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeStubSession();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    const chunk = new Uint8Array([10, 20, 30]);
    capturedClient.playAudioChunk(chunk);
    expect(ws.sent).toContain(chunk);
  });

  test("ClientSink.playAudioDone sends audio_done JSON", () => {
    let capturedClient!: ClientSink;
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeStubSession();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    capturedClient.playAudioDone();
    const sentStrings = ws.sent.filter((d): d is string => typeof d === "string");
    expect(sentStrings.some((s) => s.includes('"audio_done"'))).toBe(true);
  });

  test("ClientSink.open reflects ws.readyState", () => {
    let capturedClient!: ClientSink;
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeStubSession();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(capturedClient.open).toBe(true);
    ws.readyState = MockWebSocket.CLOSED;
    expect(capturedClient.open).toBe(false);
  });

  test("ClientSink tolerates ws.send throwing (closed socket)", () => {
    let capturedClient!: ClientSink;
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeStubSession();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Override send to throw
    ws.send = () => {
      throw new Error("socket closed");
    };
    // Should not throw
    capturedClient.event({ type: "speech_started" });
    capturedClient.playAudioChunk(new Uint8Array([1]));
    capturedClient.playAudioDone();
  });

  // ─── Close handler ──────────────────────────────────────────────────────

  test("close handler calls session.stop", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    ws.close();

    await vi.waitFor(() => {
      expect(session.stop).toHaveBeenCalledOnce();
    });
  });

  // ─── Error handler ──────────────────────────────────────────────────────

  test("error event is logged", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeStubSession(),
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
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeStubSession(),
      readyConfig: defaultConfig,
      logger,
    });

    ws.dispatchEvent(new Event("error"));

    expect(logger.error).toHaveBeenCalledWith(
      "WebSocket error",
      expect.objectContaining({ error: "WebSocket error" }),
    );
  });

  // ─── Callbacks ──────────────────────────────────────────────────────────

  test("onOpen callback is invoked when socket opens", () => {
    const onOpen = vi.fn();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeStubSession(),
      readyConfig: defaultConfig,
      onOpen,
      logger: silentLogger,
    });

    expect(onOpen).toHaveBeenCalledOnce();
  });

  test("onClose callback is invoked when socket closes", () => {
    const onClose = vi.fn();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeStubSession(),
      readyConfig: defaultConfig,
      onClose,
      logger: silentLogger,
    });

    ws.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  // ─── Concurrency regression tests ─────────────────────────────────────

  test("close during start() does not double-stop or throw", async () => {
    let resolveStart!: () => void;
    const session = makeStubSession();
    session.start = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveStart = r;
        }),
    );
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const sessions = new Map<string, Session>();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => session,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Close while start() is pending
    ws.close();

    // Now start() resolves
    resolveStart();
    await vi.waitFor(() => {
      expect(session.stop).toHaveBeenCalledOnce();
    });
  });

  test("start() failure removes session from map before close", async () => {
    const session = makeStubSession();
    session.start = vi.fn(() => Promise.reject(new Error("boom")));
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const sessions = new Map<string, Session>();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => session,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Wait for start() rejection to propagate
    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });

    // Close should not throw — session is null
    ws.close();
  });

  // ─── Session start timeout ─────────────────────────────────────────────

  test("session.start() timeout triggers 'Session start failed'", async () => {
    const session = makeStubSession();
    // start() never resolves — simulates a hanging S2S connection
    session.start = vi.fn(
      () =>
        new Promise<void>(() => {
          /* intentionally never resolves */
        }),
    );

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const sessions = new Map<string, Session>();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => session,
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

  // ─── Socket not yet open ───────────────────────────────────────────────

  test("waits for open event when readyState is not OPEN", async () => {
    const session = makeStubSession();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.CONNECTING;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => session,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Session not started yet — waiting for open
    expect(session.start).not.toHaveBeenCalled();

    // Simulate open
    ws.readyState = MockWebSocket.OPEN;
    ws.dispatchEvent(new Event("open"));

    expect(session.start).toHaveBeenCalledOnce();
  });

  // ─── No session ignores messages ───────────────────────────────────────

  test("messages before session is created are ignored", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.CONNECTING;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeStubSession(),
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Send message before open — session is null, should be ignored
    ws.simulateMessage(JSON.stringify({ type: "audio_ready" }));
    // No error thrown
  });

  // ─── Session resume ────────────────────────────────────────────────────

  test("resumeFrom reuses old session ID instead of generating new UUID", () => {
    const sessions = new Map<string, Session>();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    let capturedId: string | undefined;

    wireSessionSocket(ws, {
      sessions,
      createSession: (sid) => {
        capturedId = sid;
        return makeStubSession();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "old-session-abc",
    });

    expect(capturedId).toBe("old-session-abc");
    expect(sessions.has("old-session-abc")).toBe(true);
  });

  test("config message includes resumed session ID", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeStubSession(),
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "resume-id-123",
    });

    const config = ws.sentJson()[0];
    expect(config).toMatchObject({ type: "config", sessionId: "resume-id-123" });
  });

  test("without resumeFrom, generates a new UUID session ID", () => {
    const sessions = new Map<string, Session>();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    let capturedId: string | undefined;

    wireSessionSocket(ws, {
      sessions,
      createSession: (sid) => {
        capturedId = sid;
        return makeStubSession();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(capturedId).toBeDefined();
    expect(capturedId).not.toBe("");
    // UUID format: 8-4-4-4-12
    expect(capturedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
