// Copyright 2026 the AAI authors. MIT license.
// wireSessionSocket startup, CONFIG frame, and client-frame routing specs.
// Lifecycle/callback/ClientSink specs live in ws-handler-lifecycle.test.ts.

import { createOwnedMap } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeLogger, makeMockCore, silentLogger } from "./_test-utils.ts";
import {
  defaultConfig,
  openSocket,
  simulateBinaryFrame,
  simulateTextFrame,
  waitForSessionReady,
} from "./_ws-handler-test-utils.ts";
import type { SessionCore } from "./session-core.ts";
import { wireSessionSocket } from "./ws-handler.ts";

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

  /**
   * The production pair this stops: a missing TTS key reported
   * `session error (fatal)` and `Session ready` landed 400ms later, so the log read
   * as though a session that could never speak had come up fine. The session still
   * STARTS — the transport owns that policy — but the line stops claiming it is
   * healthy, and carries the code so the two lines read as one event.
   */
  test("a session that reported a fatal error is not logged as plainly ready", async () => {
    const logs: { msg: string; meta: Record<string, unknown> | undefined }[] = [];
    const record = (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta });
    const logger = { info: record, warn: record, error: record, debug: record };

    const core = makeMockCore({ faultCode: "tts" });
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger,
    });

    await vi.waitFor(() => {
      expect(logs).toContainEqual(
        expect.objectContaining({
          msg: "Session ready after a fatal error",
          meta: expect.objectContaining({ code: "tts" }),
        }),
      );
    });
    expect(logs.map((l) => l.msg)).not.toContain("Session ready");
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

  // The handshake is an EVENT now (`session.configured`), so the session emits it
  // and this layer's job is only to ask, at zero RTT and before `start()`. The
  // frame's own contents are asserted where they are built, in
  // `session-core.test.ts` — one claim per layer, rather than this file reaching
  // through a mock core to a socket.
  test("asks the session to announce itself, with the negotiated audio config", () => {
    const core = makeMockCore();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    expect(core.configure).toHaveBeenCalledWith(defaultConfig);
  });

  test("announces before starting the session, so the client is never left waiting", () => {
    const order: string[] = [];
    const core = makeMockCore({
      configure: vi.fn(() => order.push("configure")),
      start: vi.fn(() => {
        order.push("start");
        return Promise.resolve();
      }),
    });
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });

    // A socket that has been open for seconds carrying nothing is a wedged peer,
    // not a slow one — aai-ui's handshake guard is armed on this frame — so the
    // announcement may not wait on provider connections.
    expect(order).toEqual(["configure", "start"]);
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

  test("audio_ready JSON text frame routes to an `audio_ready` command", async () => {
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
    expect(core.command).toHaveBeenCalledWith({ type: "audio_ready" });
  });

  test("cancel JSON text frame routes to a `cancel` command", async () => {
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
    expect(core.command).toHaveBeenCalledWith({ type: "cancel" });
  });

  test("reset JSON text frame routes to a `reset` command", async () => {
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
    expect(core.command).toHaveBeenCalledWith({ type: "reset" });
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
    expect(core.command).not.toHaveBeenCalledWith({ type: "audio_ready" });
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
    expect(core.command).not.toHaveBeenCalledWith({ type: "audio_ready" });
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
    expect(core.command).not.toHaveBeenCalledWith({ type: "cancel" });

    startGate.resolve();
    await waitForSessionReady(logger);

    expect(core.command).toHaveBeenCalledWith({ type: "cancel" });
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
    expect(core.command).not.toHaveBeenCalledWith({ type: "audio_ready" });
    expect(ws.sent).toEqual([]);
  });
});
