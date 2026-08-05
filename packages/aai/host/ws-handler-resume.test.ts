// Copyright 2026 the AAI authors. MIT license.
// wireSessionSocket resume (`?sessionId=<id>` / resumeFrom) specs: id reuse,
// the resume-while-draining overlap races, and superseded-session eviction.
// Split from ws-handler-lifecycle.test.ts for file length.

import { describe, expect, test, vi } from "vitest";
import { createOwnedMap } from "../sdk/owned-map.ts";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeMockCore, silentLogger, sleep } from "./_test-utils.ts";
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

describe("wireSessionSocket resume", () => {
  test("resumeFrom reuses old session ID instead of generating new UUID", () => {
    const sessions = createOwnedMap<string, SessionCore>();
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
      sessions: createOwnedMap(),
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
    const sessions = createOwnedMap<string, SessionCore>();
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
      expect(onSessionEnd).toHaveBeenCalledWith("resume-race-id", expect.anything());
    });
    expect(sessions.get("resume-race-id")).toBe(newCore);
  });

  test("resuming an id whose session is still live evicts the superseded session", async () => {
    // The resume path is meant for the post-disconnect grace window, but a
    // fast reconnect can land before the server sees the old socket close —
    // and a replayed id can land at any time. Left running, the old session
    // would share tool state concurrently with the new one and escape
    // runtime.shutdown() once the claim replacement orphans it.
    const sessions = createOwnedMap<string, SessionCore>();
    const oldCore = makeMockCore({ stop: vi.fn(() => Promise.resolve()) });
    const oldWs = openSocket();
    wireSessionSocket(oldWs, {
      sessions,
      createSession: () => oldCore,
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "hijack-id",
    });
    expect(sessions.get("hijack-id")).toBe(oldCore);
    expect(oldCore.stop).not.toHaveBeenCalled();

    // Old socket is still OPEN when a second connection presents the same id.
    const newCore = makeMockCore();
    const newWs = openSocket();
    wireSessionSocket(newWs, {
      sessions,
      createSession: () => newCore,
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "hijack-id",
    });

    // The new session owns the id; the superseded one is stopped and its
    // socket closed so its client gets a real signal.
    expect(sessions.get("hijack-id")).toBe(newCore);
    expect(oldCore.stop).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(oldWs.readyState).toBe(MockWebSocket.CLOSED);
    });
    // The old connection's close-handler teardown must not evict the new
    // session's entry.
    expect(sessions.get("hijack-id")).toBe(newCore);
  });

  test("start-timeout cleanup after close does not evict a resumed session", async () => {
    const sessions = createOwnedMap<string, SessionCore>();
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
    await sleep(60);
    expect(sessions.get("timeout-race-id")).toBe(newCore);

    stopGate.resolve();
    await vi.waitFor(() => {
      expect(sessions.get("timeout-race-id")).toBe(newCore);
    });
  });
});
