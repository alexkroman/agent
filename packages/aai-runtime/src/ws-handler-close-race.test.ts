// Copyright 2026 the AAI authors. MIT license.
// Races between the WebSocket closing and session.start() settling.
// (Lives outside ws-handler.test.ts, which is at its file-length ceiling.)

import { createOwnedMap } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { makeMockCore, silentLogger, tick } from "./_test-utils.ts";
import { defaultConfig, openSocket } from "./_ws-handler-test-utils.ts";
import type { ServerSession } from "./session-core.ts";
import { wireSessionSocket } from "./ws-handler.ts";

describe("wireSessionSocket — close during start()", () => {
  test("buffered frames are not dispatched into the stopped session when start() later resolves", async () => {
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

    // Client streams audio while start() is still in flight — buffered.
    ws.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([1, 2, 3]) }));

    // Socket closes before start() settles; the session is stopped.
    ws.close();
    await vi.waitFor(() => expect(core.stop).toHaveBeenCalled());

    // start() finally resolves — the buffer must not drain into the stopped
    // session, and it must not be marked ready.
    startGate.resolve();
    await tick();
    expect(core.onAudio).not.toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });

  test("session cleanup runs exactly once when close precedes a start() failure", async () => {
    const startGate = Promise.withResolvers<void>();
    const core = makeMockCore({ start: vi.fn(() => startGate.promise) });
    const ws = openSocket();
    const onSessionEnd = vi.fn();

    wireSessionSocket(ws, {
      sessions: createOwnedMap<string, ServerSession>(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
      onSessionEnd,
    });

    ws.close();
    await vi.waitFor(() => expect(core.stop).toHaveBeenCalled());

    startGate.reject(new Error("boom"));
    await tick();
    expect(core.stop).toHaveBeenCalledTimes(1);
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  test("frames arriving after close are dropped", async () => {
    const core = makeMockCore();
    const ws = openSocket();

    wireSessionSocket(ws, {
      sessions: createOwnedMap<string, ServerSession>(),
      createSession: () => core,
      readyConfig: defaultConfig,
      logger: silentLogger,
    });
    await vi.waitFor(() => expect(core.start).toHaveBeenCalled());

    ws.close();
    ws.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([9]) }));
    await tick();
    expect(core.onAudio).not.toHaveBeenCalled();
  });
});
