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

  test("playAudioChunk closes a stalled client once the socket buffer exceeds the cap", async () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();
    const logger = makeLogger();
    const sessions = new Map<string, SessionCore>();
    const closeSpy = vi.spyOn(ws, "close");

    wireSessionSocket(ws, {
      sessions,
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger,
    });

    // Below the cap: audio flows.
    ws.bufferedAmount = 1024;
    capturedClient.playAudioChunk(new Uint8Array([1]));
    expect((ws.sent as unknown[]).filter((d) => d instanceof Uint8Array)).toHaveLength(1);

    // Past the cap: the client is stalled — warn once and close the socket.
    ws.bufferedAmount = 5 * 1024 * 1024;
    capturedClient.playAudioChunk(new Uint8Array([2]));
    capturedClient.playAudioChunk(new Uint8Array([3]));

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(closeSpy).toHaveBeenCalledWith(1008, "audio backlog exceeded");
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "ws: client audio backlog exceeded; closing stalled connection",
      expect.objectContaining({ bufferedBytes: 5 * 1024 * 1024 }),
    );
    // No further audio was sent after the stall was detected.
    expect((ws.sent as unknown[]).filter((d) => d instanceof Uint8Array)).toHaveLength(1);

    // MockWebSocket.close dispatches `close`, so normal teardown runs.
    await vi.waitFor(() => {
      expect(sessions.size).toBe(0);
    });
  });

  test("playAudioChunk skips the backpressure guard when bufferedAmount is unavailable", () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();
    // Simulate a socket abstraction without bufferedAmount.
    (ws as { bufferedAmount: number | undefined }).bufferedAmount = undefined;

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    capturedClient.playAudioChunk(new Uint8Array([1]));
    expect((ws.sent as unknown[]).filter((d) => d instanceof Uint8Array)).toHaveLength(1);
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
    const startGate = Promise.withResolvers<void>();
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

  const textFrames = (ws: MockWebSocket): Record<string, unknown>[] =>
    (ws.sent as unknown[])
      .filter((d): d is string => typeof d === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);

  test("start() failure sends the client an error frame and closes the socket", async () => {
    const core = makeMockCore({ start: vi.fn(() => Promise.reject(new Error("boom"))) });
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Without this the client, which already got `config`, streams audio into a
    // dead session forever with no retry signal.
    await vi.waitFor(() => {
      expect(textFrames(ws).some((f) => f.type === "error")).toBe(true);
    });
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  test("createSession throwing sends an error frame and closes without crashing", () => {
    const ws = openSocket();
    const sessions = new Map<string, SessionCore>();

    // A synchronous throw from createSession (e.g. buildTransport rejecting an
    // unregistered transport kind) must not escape as an uncaughtException.
    expect(() =>
      wireSessionSocket(ws, {
        sessions,
        createSession: () => {
          throw new Error("unregistered transport kind");
        },
        readyConfig: defaultConfig,
        logger: silentLogger,
      }),
    ).not.toThrow();

    expect(textFrames(ws).some((f) => f.type === "error")).toBe(true);
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(sessions.size).toBe(0);
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

  test("old session's delayed stop does not evict a resumed session with the same id", async () => {
    const sessions = new Map<string, SessionCore>();
    const onSessionEnd = vi.fn();
    const stopGate = Promise.withResolvers<void>();
    const oldCore = makeMockCore({ stop: vi.fn(() => stopGate.promise) });
    const oldWs = openSocket();

    wireSessionSocket(oldWs, {
      sessions,
      createSession: () => oldCore,
      readyConfig: defaultConfig,
      logger: silentLogger,
      onSessionEnd,
      resumeFrom: "resume-race-id",
    });
    expect(sessions.get("resume-race-id")).toBe(oldCore);

    // Client disconnects — the old session's stop() starts draining slowly
    // (in-flight tool / transport teardown).
    oldWs.close();
    expect(oldCore.stop).toHaveBeenCalledOnce();

    // Client reconnects and resumes the same session id before stop settles.
    const newCore = makeMockCore();
    const newWs = openSocket();
    wireSessionSocket(newWs, {
      sessions,
      createSession: () => newCore,
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "resume-race-id",
    });
    expect(sessions.get("resume-race-id")).toBe(newCore);

    // The old stop settles — its cleanup must not delete the NEW session's
    // registry entry (it would escape runtime.shutdown()).
    stopGate.resolve();
    await vi.waitFor(() => {
      expect(onSessionEnd).toHaveBeenCalledWith("resume-race-id");
    });
    expect(sessions.get("resume-race-id")).toBe(newCore);
  });

  test("start-timeout cleanup after close does not evict a resumed session", async () => {
    const sessions = new Map<string, SessionCore>();
    const stopGate = Promise.withResolvers<void>();
    const oldCore = makeMockCore({
      start: vi.fn(
        () =>
          new Promise<void>(() => {
            /* never resolves */
          }),
      ),
      stop: vi.fn(() => stopGate.promise),
    });
    const oldWs = openSocket();

    wireSessionSocket(oldWs, {
      sessions,
      createSession: () => oldCore,
      readyConfig: defaultConfig,
      logger: silentLogger,
      sessionStartTimeoutMs: 30,
      resumeFrom: "timeout-race-id",
    });

    // Close before the start timeout fires: endSession runs (pending on the
    // slow stop) and the timeout's catch later sees session === null.
    oldWs.close();

    const newCore = makeMockCore();
    const newWs = openSocket();
    wireSessionSocket(newWs, {
      sessions,
      createSession: () => newCore,
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "timeout-race-id",
    });
    expect(sessions.get("timeout-race-id")).toBe(newCore);

    // Let the start timeout fire; its cleanup must not key-delete the
    // resumed session's entry.
    await new Promise((r) => setTimeout(r, 60));
    expect(sessions.get("timeout-race-id")).toBe(newCore);

    stopGate.resolve();
    await vi.waitFor(() => {
      expect(sessions.get("timeout-race-id")).toBe(newCore);
    });
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
  // ── Keepalive ──────────────────────────────────────────────────────────────
  // A silent voice session sends nothing client-ward until the user speaks, and
  // a deployed agent behind Fly's proxy was dropped ~40s into that silence with
  // no close frame. These pin the ping that keeps the connection warm.

  test("pings the socket on the keepalive interval while open", () => {
    vi.useFakeTimers();
    try {
      const ping = vi.fn();
      const ws = Object.assign(openSocket(), { ping });

      wireSessionSocket(ws, {
        sessions: new Map(),
        createSession: () => makeMockCore(),
        readyConfig: defaultConfig,
        logger: silentLogger,
        keepaliveIntervalMs: 1000,
      });

      expect(ping).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3000);
      expect(ping).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops pinging once the socket closes", () => {
    vi.useFakeTimers();
    try {
      const ping = vi.fn();
      const ws = Object.assign(openSocket(), { ping });

      wireSessionSocket(ws, {
        sessions: new Map(),
        createSession: () => makeMockCore(),
        readyConfig: defaultConfig,
        logger: silentLogger,
        keepaliveIntervalMs: 1000,
      });

      vi.advanceTimersByTime(2000);
      expect(ping).toHaveBeenCalledTimes(2);

      ws.disconnect(1006);
      vi.advanceTimersByTime(5000);
      // Still 2: a leaked interval would keep firing against a dead socket.
      expect(ping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a socket with no ping method is wired without throwing", () => {
    vi.useFakeTimers();
    try {
      const ws = openSocket(); // MockWebSocket has no ping()
      expect(() =>
        wireSessionSocket(ws, {
          sessions: new Map(),
          createSession: () => makeMockCore(),
          readyConfig: defaultConfig,
          logger: silentLogger,
          keepaliveIntervalMs: 1000,
        }),
      ).not.toThrow();
      expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  test("logs the close code so a dropped session is diagnosable", () => {
    const logger = makeLogger();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger,
    });

    ws.disconnect(1006);

    const disconnect = logger.info.mock.calls.find((c) => c[0] === "Session disconnected");
    expect(disconnect?.[1]).toMatchObject({ code: 1006 });
  });
});

/**
 * Pacing specs. The sink relays TTS audio at a bounded lead over real time
 * rather than the instant a provider frame arrives, which also makes ordering
 * relative to `audio_done` and to a barge-in load-bearing.
 */
describe("wireSessionSocket audio pacing", () => {
  /** 24 kHz PCM16 is 48 bytes/ms, so this is 100ms of audio. */
  const CHUNK = () => new Uint8Array(4800);

  function pacedSink(): { ws: MockWebSocket; client: ClientSink } {
    const ws = openSocket();
    let client!: ClientSink;
    wireSessionSocket(ws, {
      sessions: new Map(),
      createSession: (_sid, sink) => {
        client = sink;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });
    return { ws, client };
  }

  const binaryFrames = (ws: MockWebSocket): unknown[] =>
    (ws.sent as unknown[]).filter((d) => d instanceof Uint8Array);

  const jsonTypes = (ws: MockWebSocket): string[] =>
    (ws.sent as unknown[])
      .filter((d): d is string => typeof d === "string")
      .map((s) => (JSON.parse(s) as { type: string }).type);

  test("holds a reply that outruns real time instead of filling the socket buffer", () => {
    vi.useFakeTimers();
    try {
      const { ws, client } = pacedSink();
      // 2s of audio, produced as fast as a TTS provider can emit it.
      for (let i = 0; i < 20; i++) client.playAudioChunk(CHUNK());

      const sent = binaryFrames(ws).length;
      expect(sent).toBeLessThan(20);
      expect(sent).toBeGreaterThan(0);

      vi.advanceTimersByTime(2000);
      expect(binaryFrames(ws)).toHaveLength(20);
    } finally {
      vi.useRealTimers();
    }
  });

  test("audio_done waits for the audio it follows", () => {
    vi.useFakeTimers();
    try {
      const { ws, client } = pacedSink();
      for (let i = 0; i < 20; i++) client.playAudioChunk(CHUNK());
      client.playAudioDone();

      // Arriving early, audio_done would end the turn client-side and the
      // tail of the reply would never be spoken.
      expect(jsonTypes(ws)).not.toContain("audio_done");

      vi.advanceTimersByTime(2000);
      expect(jsonTypes(ws)).toContain("audio_done");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a cancelled event discards audio held for the killed turn", () => {
    vi.useFakeTimers();
    try {
      const { ws, client } = pacedSink();
      for (let i = 0; i < 20; i++) client.playAudioChunk(CHUNK());
      const sentBeforeCancel = binaryFrames(ws).length;

      // The client flushes its own buffer on this event, so held audio must
      // not follow it down the socket.
      client.event({ type: "cancelled" });
      vi.advanceTimersByTime(5000);

      expect(binaryFrames(ws)).toHaveLength(sentBeforeCancel);
    } finally {
      vi.useRealTimers();
    }
  });

  test("closing the socket stops paced sends", () => {
    vi.useFakeTimers();
    try {
      const { ws, client } = pacedSink();
      for (let i = 0; i < 20; i++) client.playAudioChunk(CHUNK());
      const sentBeforeClose = binaryFrames(ws).length;

      ws.dispatchEvent(new CloseEvent("close"));
      vi.advanceTimersByTime(5000);

      expect(binaryFrames(ws)).toHaveLength(sentBeforeClose);
    } finally {
      vi.useRealTimers();
    }
  });
});
