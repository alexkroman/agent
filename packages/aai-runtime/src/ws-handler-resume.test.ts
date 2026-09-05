// Copyright 2026 the AAI authors. MIT license.
// wireSessionSocket resume (`?sessionId=<id>` / resumeFrom) specs: id reuse,
// the resume-while-draining overlap races, and superseded-session eviction.
// Split from ws-handler-lifecycle.test.ts for file length.

import { DEFAULT_SESSION_START_TIMEOUT_MS } from "@alexkroman1/aai/host-internal";
import { createOwnedMap } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { MockWebSocket } from "./_mock-ws.ts";
import { makeLogger, makeMockCore, silentLogger } from "./_test-utils.ts";
import { defaultConfig, openSocket } from "./_ws-handler-test-utils.ts";
import type { ServerSession } from "./session-core.ts";
import { wireSessionSocket } from "./ws-handler.ts";

describe("wireSessionSocket resume", () => {
  test("resumeFrom reuses old session ID instead of generating new UUID", () => {
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
      resumeFrom: "old-session-abc",
    });

    expect(capturedId).toBe("old-session-abc");
    expect(sessions.has("old-session-abc")).toBeTruthy();
  });

  test("the resumed id is the session's id, so its announcement carries it", () => {
    const ws = openSocket();
    let capturedId: string | undefined;

    wireSessionSocket(ws, {
      sessions: createOwnedMap(),
      createSession: (sid) => {
        capturedId = sid;
        return makeMockCore();
      },
      readyConfig: defaultConfig,
      logger: silentLogger,
      resumeFrom: "resume-id-123",
    });

    // `session.configured` carries `sessionId: opts.id` (see `ServerSession.configure`),
    // so asserting the id the session was BUILT with is the same claim without
    // reaching through a mock core to the socket.
    expect(capturedId).toBe("resume-id-123");
  });

  test("old session's delayed stop does not evict a resumed session with the same id", async () => {
    const sessions = createOwnedMap<string, ServerSession>();
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
    const sessions = createOwnedMap<string, ServerSession>();
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
    // Virtual time, and the SHIPPED window. On the wall clock this had to
    // shrink the start timeout to 30ms — a value the product never uses, and
    // the same order as a scheduling hiccup, so the flake would name a timing
    // spec rather than a bug. The two waits were also not synchronizing on
    // anything: `sleep(60)` guessed at the timeout firing, and the closing
    // `vi.waitFor` re-asserted an expression the line above had just asserted,
    // so it passed on its first synchronous poll — BEFORE the settled stop's
    // cleanup ran, which is the moment the whole spec is about. Both waits now
    // observe the event they name: the timeout's own log line, and
    // `onSessionEnd`, which the old connection's cleanup fires last.
    vi.useFakeTimers();
    try {
      const sessions = createOwnedMap<string, ServerSession>();
      const logger = makeLogger();
      const onSessionEnd = vi.fn();
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
        logger,
        onSessionEnd,
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
      await vi.advanceTimersByTimeAsync(DEFAULT_SESSION_START_TIMEOUT_MS);
      expect(logger.error).toHaveBeenCalledWith(
        "Session start failed",
        expect.objectContaining({ error: expect.stringContaining("timed out") }),
      );
      expect(sessions.get("timeout-race-id")).toBe(newCore);

      // And neither may the OLD stop settling afterwards. `onSessionEnd` runs
      // in the same `finally` as the entry release, so it is the signal that
      // the cleanup under test has actually happened.
      stopGate.resolve();
      await vi.waitFor(() => {
        expect(onSessionEnd).toHaveBeenCalledWith("timeout-race-id", expect.anything());
      });
      expect(sessions.get("timeout-race-id")).toBe(newCore);
    } finally {
      vi.useRealTimers();
    }
  });
});
