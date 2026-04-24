import { describe, expect, test, vi } from "vitest";
import type { ClientSink } from "../sdk/protocol.ts";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeLogger, makeMockCore, silentLogger } from "./_test-utils.ts";
import type { SessionCore } from "./session-core.ts";
import { wireSessionSocket } from "./ws-handler.ts";

// ─── Test helpers ────────────────────────────────────────────────────────────

const defaultConfig = { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 };

/** Simulate a binary frame arriving on the WebSocket. */
function simulateBinaryFrame(ws: MockWebSocket, frame: Uint8Array): void {
  ws.dispatchEvent(new MessageEvent("message", { data: frame }));
}

/** Simulate a string (text) frame arriving on the WebSocket. */
function simulateTextFrame(ws: MockWebSocket, text: string): void {
  ws.dispatchEvent(new MessageEvent("message", { data: text }));
}

/** Wait until wireSessionSocket has fully initialized (sessionReady = true). */
async function waitForSessionReady(logger: { info: ReturnType<typeof vi.fn> }): Promise<void> {
  await vi.waitFor(() => {
    const calls = logger.info.mock.calls.map((c: unknown[]) => c[0]);
    if (!calls.includes("Session ready")) throw new Error("Session not ready yet");
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("wireSessionSocket", () => {
  // ─── Lifecycle: startup ──────────────────────────────────────────────────

  test("'Session ready' is not logged until session.start() resolves", async () => {
    const logs: string[] = [];
    const logger = {
      info: (msg: string) => logs.push(msg),
      warn: (msg: string) => logs.push(msg),
      error: (msg: string) => logs.push(msg),
      debug: (msg: string) => logs.push(msg),
    };

    let resolveStart!: () => void;
    const core = makeMockCore({
      start: vi.fn(
        () =>
          new Promise<void>((r) => {
            resolveStart = r;
          }),
      ),
    });

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    expect(core.start).toHaveBeenCalled();
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

    const core = makeMockCore({ start: vi.fn(() => Promise.reject(new Error("boom"))) });

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

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

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

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

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

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

  // ─── CONFIG frame on open ────────────────────────────────────────────────

  test("sends CONFIG JSON frame as first message on open", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
    const firstFrame = ws.sent[0];
    expect(typeof firstFrame).toBe("string");
    const msg = JSON.parse(firstFrame as string);
    expect(msg.type).toBe("config");
  });

  test("CONFIG frame contains correct sampleRate and ttsSampleRate", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    const firstFrame = ws.sent[0];
    const msg = JSON.parse(firstFrame as string);
    expect(msg.type).toBe("config");
    expect(msg.audioFormat).toBe("pcm16");
    expect(msg.sampleRate).toBe(16_000);
    expect(msg.ttsSampleRate).toBe(24_000);
  });

  test("CONFIG frame includes the session ID as sessionId", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const sessions = new Map<string, SessionCore>();
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

    const firstFrame = ws.sent[0];
    const msg = JSON.parse(firstFrame as string);
    expect(msg.type).toBe("config");
    expect(msg.sessionId).toBeTruthy();
    expect(msg.sessionId).toBe(capturedId);
  });

  // ─── Inbound C2S frame routing ───────────────────────────────────────────

  test("raw binary Uint8Array routes to session.onAudio", async () => {
    const core = makeMockCore();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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

  // ─── Text message error handling ─────────────────────────────────────────

  test("invalid JSON text frame is dropped with warning, session not closed", async () => {
    const core = makeMockCore();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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
    // Session methods must not be called
    expect(core.onAudioReady).not.toHaveBeenCalled();
    // Socket must still be open (not closed)
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
  });

  test("unknown client message type is silently dropped", async () => {
    const core = makeMockCore();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    await waitForSessionReady(logger);

    // Valid JSON with a valid { type } envelope but unknown type — lenientParse returns ok:false, malformed:false
    simulateTextFrame(ws, JSON.stringify({ type: "some_future_message_type" }));
    // Must NOT warn — rolling-upgrade tolerance
    expect(logger.warn).not.toHaveBeenCalled();
    expect(core.onAudioReady).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
  });

  // ─── Message buffering ───────────────────────────────────────────────────

  test("frames before session is ready are buffered and replayed after start()", async () => {
    let resolveStart!: () => void;
    const core = makeMockCore({
      start: vi.fn(
        () =>
          new Promise<void>((r) => {
            resolveStart = r;
          }),
      ),
    });

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const logger = makeLogger();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    // Session not ready yet — send a cancel text frame
    simulateTextFrame(ws, JSON.stringify({ type: "cancel" }));
    expect(core.onCancel).not.toHaveBeenCalled();

    // Now let start() resolve
    resolveStart();
    await waitForSessionReady(logger);

    expect(core.onCancel).toHaveBeenCalledOnce();
  });

  test("messages before session is created (no open yet) are ignored", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.CONNECTING;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // No open yet — session is null, should be silently ignored
    simulateTextFrame(ws, JSON.stringify({ type: "audio_ready" }));
    // No error thrown
  });

  // ─── Close handler ───────────────────────────────────────────────────────

  test("close handler calls session.stop", async () => {
    const core = makeMockCore();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

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

  // ─── Error handler ───────────────────────────────────────────────────────

  test("error event is logged", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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

  // ─── Callbacks ───────────────────────────────────────────────────────────

  test("onOpen callback is invoked when socket opens", () => {
    const onOpen = vi.fn();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

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
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

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
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

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

  // ─── ClientSink (indirect testing via createSession capture) ─────────────

  test("ClientSink.open reflects ws.readyState", () => {
    let capturedClient!: ClientSink;
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

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
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

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

    // Find binary frames in sent (skip the initial config JSON string)
    const binaryFrames = (ws.sent as unknown[]).filter((d) => d instanceof Uint8Array);
    expect(binaryFrames.length).toBeGreaterThanOrEqual(1);
    expect(binaryFrames[0]).toBe(chunk);
  });

  test("ClientSink.playAudioDone sends audio_done JSON text frame", () => {
    let capturedClient!: ClientSink;
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

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

    // Find JSON string frames after the initial config
    const textFrames = (ws.sent as unknown[])
      .filter((d): d is string => typeof d === "string")
      .map((s) => JSON.parse(s));
    const audioDoneFrame = textFrames.find((m) => m.type === "audio_done");
    expect(audioDoneFrame).toBeDefined();
  });

  test("ClientSink tolerates ws.send throwing (closed socket)", () => {
    let capturedClient!: ClientSink;
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
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

  // ─── Concurrency regression tests ────────────────────────────────────────

  test("close during start() does not double-stop or throw", async () => {
    let resolveStart!: () => void;
    const core = makeMockCore({
      start: vi.fn(
        () =>
          new Promise<void>((r) => {
            resolveStart = r;
          }),
      ),
    });
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
    const sessions = new Map<string, SessionCore>();

    wireSessionSocket(ws, {
      sessions,
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Close while start() is pending
    ws.close();

    // Now start() resolves
    resolveStart();
    await vi.waitFor(() => {
      expect(core.stop).toHaveBeenCalledOnce();
    });
  });

  test("start() failure removes session from map before close", async () => {
    const core = makeMockCore({ start: vi.fn(() => Promise.reject(new Error("boom"))) });
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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

    // Close should not throw — session is null
    ws.close();
  });

  // ─── Session start timeout ────────────────────────────────────────────────

  test("session.start() timeout triggers 'Session start failed'", async () => {
    const core = makeMockCore({
      start: vi.fn(
        () =>
          new Promise<void>(() => {
            /* intentionally never resolves */
          }),
      ),
    });

    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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

  // ─── Socket not yet open ──────────────────────────────────────────────────

  test("waits for open event when readyState is not OPEN", async () => {
    const core = makeMockCore();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.CONNECTING;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Session not started yet — waiting for open
    expect(core.start).not.toHaveBeenCalled();

    // Simulate open
    ws.readyState = MockWebSocket.OPEN;
    ws.dispatchEvent(new Event("open"));

    expect(core.start).toHaveBeenCalledOnce();
  });

  // ─── Session resume ───────────────────────────────────────────────────────

  test("resumeFrom reuses old session ID instead of generating new UUID", () => {
    const sessions = new Map<string, SessionCore>();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "resume-id-123",
    });

    const firstFrame = ws.sent[0];
    const msg = JSON.parse(firstFrame as string);
    expect(msg.type).toBe("config");
    expect(msg.sessionId).toBe("resume-id-123");
  });

  test("without resumeFrom, generates a new UUID session ID", () => {
    const sessions = new Map<string, SessionCore>();
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;
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
    // UUID format: 8-4-4-4-12
    expect(capturedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
