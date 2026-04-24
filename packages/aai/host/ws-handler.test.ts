import { describe, expect, test, vi } from "vitest";
import type { ClientSink } from "../sdk/protocol.ts";
import {
  C2S,
  decodeS2C,
  encAudioChunkC2S,
  encAudioReady,
  encCancel,
  encHistory,
  encResetC2S,
} from "../sdk/wire.ts";
import { MockWebSocket } from "./_mock-ws.ts";
import { silentLogger } from "./_test-utils.ts";
import type { SessionCore } from "./session-core.ts";
import { wireSessionSocket } from "./ws-handler.ts";

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Create a SessionCore-shaped mock with all methods as vi.fn() spies. */
function makeMockCore(overrides?: Partial<SessionCore>): SessionCore {
  return {
    id: "test",
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    onAudio: vi.fn(),
    onAudioReady: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
    onHistory: vi.fn(),
    onReplyStarted: vi.fn(),
    onReplyDone: vi.fn(),
    onCancelled: vi.fn(),
    onAudioChunk: vi.fn(),
    onAudioDone: vi.fn(),
    onUserTranscript: vi.fn(),
    onAgentTranscript: vi.fn(),
    onToolCall: vi.fn(),
    onError: vi.fn(),
    onSpeechStarted: vi.fn(),
    onSpeechStopped: vi.fn(),
    ...overrides,
  };
}

const defaultConfig = { audioFormat: "pcm16" as const, sampleRate: 16_000, ttsSampleRate: 24_000 };

/** Simulate a binary frame arriving on the WebSocket (bypasses simulateMessage signature). */
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

  test("sends CONFIG binary frame as first message on open", () => {
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
    expect(firstFrame).toBeInstanceOf(Uint8Array);
    const decoded = decodeS2C(firstFrame as Uint8Array);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.data.type).toBe("config");
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

    const firstFrame = ws.sent[0] as Uint8Array;
    const decoded = decodeS2C(firstFrame);
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.data.type === "config") {
      expect(decoded.data.sampleRate).toBe(16_000);
      expect(decoded.data.ttsSampleRate).toBe(24_000);
    }
  });

  test("CONFIG frame includes the session ID as sid", () => {
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

    const firstFrame = ws.sent[0] as Uint8Array;
    const decoded = decodeS2C(firstFrame);
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.data.type === "config") {
      expect(decoded.data.sid).toBe(capturedId);
    }
  });

  // ─── Inbound C2S frame routing ───────────────────────────────────────────

  test("AUDIO_CHUNK frame routes to session.onAudio", async () => {
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
    simulateBinaryFrame(ws, encAudioChunkC2S(pcm));

    expect(core.onAudio).toHaveBeenCalledOnce();
    const passed = (core.onAudio as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(passed).toBeInstanceOf(Uint8Array);
  });

  test("AUDIO_READY frame routes to session.onAudioReady", async () => {
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
    simulateBinaryFrame(ws, encAudioReady());
    expect(core.onAudioReady).toHaveBeenCalledOnce();
  });

  test("CANCEL frame routes to session.onCancel", async () => {
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
    simulateBinaryFrame(ws, encCancel());
    expect(core.onCancel).toHaveBeenCalledOnce();
  });

  test("RESET frame routes to session.onReset", async () => {
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
    simulateBinaryFrame(ws, encResetC2S());
    expect(core.onReset).toHaveBeenCalledOnce();
  });

  test("HISTORY frame routes to session.onHistory with decoded messages", async () => {
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
    simulateBinaryFrame(ws, encHistory(messages));
    expect(core.onHistory).toHaveBeenCalledOnce();
    const passed = (core.onHistory as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(passed).toEqual(messages);
  });

  // ─── Wire decode failure handling ────────────────────────────────────────

  test("non-binary (string) frame is dropped with warning, session not closed", async () => {
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
    expect(logger.warn).toHaveBeenCalledWith(
      "ws: non-binary frame received; dropping",
      expect.any(Object),
    );
    // Session methods must not be called
    expect(core.onAudioReady).not.toHaveBeenCalled();
    // Socket must still be open (not closed)
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
  });

  test("truncated binary frame (unknown type byte) is dropped with warning", async () => {
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

    // 0xFF is not a valid C2S type code
    simulateBinaryFrame(ws, new Uint8Array([0xff, 1, 2, 3]));
    expect(logger.warn).toHaveBeenCalledWith("ws: wire decode failed", expect.any(Object));
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
  });

  test("empty binary frame is dropped with wire decode warning", async () => {
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

    simulateBinaryFrame(ws, new Uint8Array(0));
    expect(logger.warn).toHaveBeenCalledWith("ws: wire decode failed", expect.any(Object));
  });

  test("truncated HISTORY frame is dropped with wire decode warning", async () => {
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

    // HISTORY type byte but only 3 bytes total (header needs 5)
    simulateBinaryFrame(ws, new Uint8Array([C2S.HISTORY, 0x01, 0x00]));
    expect(logger.warn).toHaveBeenCalledWith("ws: wire decode failed", expect.any(Object));
    expect(core.onHistory).not.toHaveBeenCalled();
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

    // Session not ready yet — send a cancel frame
    simulateBinaryFrame(ws, encCancel());
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
    simulateBinaryFrame(ws, encAudioReady());
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

  test("ClientSink.audio sends binary AUDIO_CHUNK frame", () => {
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
    capturedClient.audio(chunk);

    // Find the audio_chunk frame in sent (skip the initial config)
    const audioFrames = (ws.sent as Uint8Array[]).filter(
      (d) => d instanceof Uint8Array && d[0] === 0x80,
    );
    expect(audioFrames.length).toBeGreaterThanOrEqual(1);
    const decoded = decodeS2C(audioFrames[0] as Uint8Array);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.data.type).toBe("audio_chunk");
  });

  test("ClientSink.audioDone sends AUDIO_DONE frame", () => {
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

    capturedClient.audioDone();

    const frames = (ws.sent as Uint8Array[]).filter(
      (d) => d instanceof Uint8Array && d[0] === 0x81,
    );
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const decoded = decodeS2C(frames[0] as Uint8Array);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.data.type).toBe("audio_done");
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
    capturedClient.speechStarted();
    capturedClient.audio(new Uint8Array([1]));
    capturedClient.audioDone();
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

  test("CONFIG frame contains resumed session ID as sid", () => {
    const ws = new MockWebSocket("ws://test");
    ws.readyState = MockWebSocket.OPEN;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "resume-id-123",
    });

    const firstFrame = ws.sent[0] as Uint8Array;
    const decoded = decodeS2C(firstFrame);
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.data.type === "config") {
      expect(decoded.data.sid).toBe("resume-id-123");
    }
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
