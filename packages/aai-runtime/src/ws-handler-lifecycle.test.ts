// Copyright 2026 the AAI authors. MIT license.
// wireSessionSocket lifecycle specs: close/error handling, onOpen/onClose/
// onSessionEnd/onSinkCreated callbacks, ClientSink behavior, start-failure
// paths, and session-ID resumption. Startup/CONFIG/frame-routing specs live
// in ws-handler.test.ts.

import { createOwnedMap, DEFAULT_SESSION_START_TIMEOUT_MS } from "@alexkroman1/aai/host-internal";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeLogger, makeMockCore, silentLogger } from "./_test-utils.ts";
import { defaultConfig, openSocket } from "./_ws-handler-test-utils.ts";
import type { ServerSession } from "./session-core.ts";
import { stampSessionEvent } from "./session-event-stream.ts";
import { wireSessionSocket } from "./ws-handler.ts";

describe("wireSessionSocket lifecycle", () => {
  test("close handler calls session.stop", async () => {
    const core = makeMockCore();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
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
      sessions: createOwnedMap(),
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
      sessions: createOwnedMap(),
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
      sessions: createOwnedMap(),
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
      sessions: createOwnedMap(),
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
    const sessions = createOwnedMap<string, ServerSession>();

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
    // Second arg is the connection's sink — the identity token consumers use
    // to distinguish this teardown from a resumed session under the same id.
    expect(onSessionEnd).toHaveBeenCalledWith(sessionId, expect.anything());
    expect(sessions.size).toBe(0);
  });

  test("onSinkCreated callback is invoked with sessionId and ClientSink", () => {
    const onSinkCreated = vi.fn();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
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
      sessions: createOwnedMap(),
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
      sessions: createOwnedMap(),
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

  test("an audio.completed event goes out as a JSON text frame", () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: (_sid, client) => {
        capturedClient = client;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    capturedClient.event(stampSessionEvent({ type: "audio.completed" }));

    expect(ws.sentJson().find((m) => m.type === "audio.completed")).toBeDefined();
  });

  test("playAudioChunk closes a stalled client once the socket buffer exceeds the cap", async () => {
    let capturedClient!: ClientSink;
    const ws = openSocket();
    const logger = makeLogger();
    const sessions = createOwnedMap<string, ServerSession>();
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
      sessions: createOwnedMap(),
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
      sessions: createOwnedMap(),
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
    // A send that throws must be contained — a closed socket is the normal
    // end of every session, and an escaping throw from the sink takes out
    // whatever transport callback was writing. Stated as an assertion rather
    // than left to the test merely not failing.
    expect(() => capturedClient.event(stampSessionEvent({ type: "speech.started" }))).not.toThrow();
    expect(() => capturedClient.playAudioChunk(new Uint8Array([1]))).not.toThrow();
    expect(() =>
      capturedClient.event(stampSessionEvent({ type: "audio.completed" })),
    ).not.toThrow();
  });

  test("close during start() does not double-stop or throw", async () => {
    const startGate = Promise.withResolvers<void>();
    const core = makeMockCore({ start: vi.fn(() => startGate.promise) });
    const ws = openSocket();
    const sessions = createOwnedMap<string, ServerSession>();

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
    const sessions = createOwnedMap<string, ServerSession>();

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

  test("start() failure sends the client an error frame and closes the socket", async () => {
    const core = makeMockCore({ start: vi.fn(() => Promise.reject(new Error("boom"))) });
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // Without this the client, which already got `config`, streams audio into a
    // dead session forever with no retry signal.
    await vi.waitFor(() => {
      expect(ws.sentJson().some((f) => f.type === "error.reported")).toBe(true);
    });
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  test("createSession throwing sends an error frame and closes without crashing", () => {
    const ws = openSocket();
    const sessions = createOwnedMap<string, ServerSession>();

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

    expect(ws.sentJson().some((f) => f.type === "error.reported")).toBe(true);
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(sessions.size).toBe(0);
  });

  test("session.start() timeout triggers 'Session start failed'", async () => {
    // Fresh, not the shared `silentLogger`: its call history accumulates
    // across the file, so an identical call from an earlier test would
    // satisfy the assertion below on its own.
    //
    // Virtual time, and the SHIPPED default window rather than a 50ms one.
    // Waiting out a real 50ms made the effect under test the same size as a
    // scheduling hiccup, and left the 10s value the product actually uses
    // exercised by nothing.
    vi.useFakeTimers();
    try {
      const logger = makeLogger();
      const core = makeMockCore({
        start: vi.fn(
          () =>
            new Promise<void>(() => {
              /* never resolves */
            }),
        ),
      });
      const ws = openSocket();
      const sessions = createOwnedMap<string, ServerSession>();

      wireSessionSocket(ws, {
        sessions,
        createSession: () => core,
        readyConfig: defaultConfig,
        logger,
      });

      expect(sessions.size).toBe(1);

      await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_START_TIMEOUT_MS);
      await vi.waitFor(() => {
        expect(sessions.size).toBe(0);
      });

      expect(logger.error).toHaveBeenCalledWith(
        "Session start failed",
        expect.objectContaining({ error: expect.stringContaining("timed out") }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("waits for open event when readyState is not OPEN", () => {
    const core = makeMockCore();
    const ws = openSocket(MockWebSocket.CONNECTING);

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(core.start).not.toHaveBeenCalled();

    ws.readyState = MockWebSocket.OPEN;
    ws.dispatchEvent(new Event("open"));

    expect(core.start).toHaveBeenCalledOnce();
  });

  test("without resumeFrom, generates a new UUID session ID", () => {
    const sessions = createOwnedMap<string, ServerSession>();
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
        sessions: createOwnedMap(),
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
        sessions: createOwnedMap(),
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
          sessions: createOwnedMap(),
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
      sessions: createOwnedMap(),
      createSession: () => makeMockCore(),
      readyConfig: defaultConfig,
      logger,
    });

    ws.disconnect(1006);

    const disconnect = logger.info.mock.calls.find((c) => c[0] === "Session disconnected");
    expect(disconnect?.[1]).toMatchObject({ code: 1006 });
  });
});
