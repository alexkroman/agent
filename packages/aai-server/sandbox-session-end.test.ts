// Copyright 2026 the AAI authors. MIT license.
/**
 * Deferred guest `session/end` (resume grace window) — see sandbox.ts.
 *
 * The guest's session state (ctx.state, message cache) is keyed by session
 * id and a disconnected client may resume it (`?sessionId=<id>`), so the
 * session/end that frees it must wait out SESSION_RESUME_GRACE_MS and be
 * cancelled when the session resumes.
 */

import { SESSION_RESUME_GRACE_MS } from "@alexkroman1/aai";
import { createMemoryVector } from "@alexkroman1/aai/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { createSandbox, type SandboxOptions } from "./sandbox.ts";

// vi.mock factories are hoisted, so the mocks live in vi.hoisted.
const { mockConn, mockCreateSandboxVm } = vi.hoisted(() => {
  const mockConn: NdjsonConnection = {
    sendRequest: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn(),
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    listen: vi.fn(),
    dispose: vi.fn(),
  };
  const mockCreateSandboxVm = vi.fn().mockResolvedValue({
    conn: mockConn,
    shutdown: vi.fn().mockResolvedValue(undefined),
  });
  return { mockConn, mockCreateSandboxVm };
});

vi.mock("./sandbox-vm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-vm.ts")>()),
  createSandboxVm: mockCreateSandboxVm,
}));

vi.mock("@alexkroman1/aai/runtime", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@alexkroman1/aai/runtime")>();
  return {
    ...orig,
    createRuntime(opts: Parameters<typeof orig.createRuntime>[0]) {
      return orig.createRuntime({
        ...opts,
        // Sessions in these tests never complete a provider handshake — an
        // inert socket keeps S2S connects off the real network.
        createWebSocket: () => ({
          readyState: 0,
          send: () => undefined,
          close: () => undefined,
          addEventListener: () => undefined,
        }),
      });
    },
  };
});

const TEST_AGENT_CONFIG: IsolateConfig = {
  name: "test-agent",
  systemPrompt: "You are a test agent",
  greeting: "Hello!",
  maxSteps: 3,
  toolSchemas: [],
  builtinTools: [],
  allowedHosts: [],
};

function makeSandboxOptions(): SandboxOptions {
  return {
    workerCode: 'export default { name: "test" };',
    env: { AAI_ENV_TEST: "1" },
    slug: "test-agent",
    agentConfig: TEST_AGENT_CONFIG,
    defaultVector: (slug) => createMemoryVector({ namespace: slug }),
  };
}

/** Minimal client-session WebSocket double with manually firable events. */
function makeSessionWs() {
  const listeners = new Map<string, Array<(ev?: unknown) => void>>();
  const ws = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener(type: string, cb: (ev?: unknown) => void) {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
  };
  return {
    ws,
    fire(type: string, ev?: unknown) {
      for (const cb of listeners.get(type) ?? []) cb(ev);
    },
  };
}

describe("deferred guest session/end (resume grace window)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Only fake the timeout APIs — session teardown settles via microtasks
    // and setImmediate, which must keep running.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defers the guest session/end until the resume grace window lapses", async () => {
    const sandbox = createSandbox(makeSandboxOptions());
    const ended: string[] = [];
    const { ws, fire } = makeSessionWs();
    sandbox.startSession(ws as never, { onSessionEnd: (sid) => ended.push(sid) });

    // Client disconnects — the guest's session state must survive the
    // resume grace window, so no session/end goes out yet.
    fire("close", { code: 1000, reason: "client gone" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toHaveLength(1);
    expect(mockConn.sendNotification).not.toHaveBeenCalledWith("session/end", expect.anything());

    // No resume arrives — the deferred session/end fires after the window.
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_GRACE_MS + 1);
    expect(mockConn.sendNotification).toHaveBeenCalledWith("session/end", {
      sessionId: ended[0],
    });
    await sandbox.shutdown();
  });

  it("cancels the deferred session/end when the session resumes in time", async () => {
    const sandbox = createSandbox(makeSandboxOptions());
    const ended: string[] = [];
    const first = makeSessionWs();
    sandbox.startSession(first.ws as never, { onSessionEnd: (sid) => ended.push(sid) });
    first.fire("close", { code: 1000, reason: "network blip" });
    await vi.advanceTimersByTimeAsync(0);
    const sid = ended[0];
    expect(sid).toBeDefined();

    // Reconnect resumes the same session id before the window lapses.
    const second = makeSessionWs();
    sandbox.startSession(second.ws as never, { resumeFrom: sid as string });

    // Advance past the ORIGINAL deadline (scheduled at the disconnect):
    // had the resume not cancelled it, it would have fired by now.
    await vi.advanceTimersByTimeAsync(SESSION_RESUME_GRACE_MS + 1);
    expect(mockConn.sendNotification).not.toHaveBeenCalledWith("session/end", {
      sessionId: sid,
    });
    await sandbox.shutdown();
  });

  it("a resume overlapping the old session's drain keeps its guest state", async () => {
    // The old connection's teardown is async: a fast reconnect can register a
    // NEW session under the same id before the old onSessionEnd fires. That
    // late teardown must not arm a guest session/end — onSinkCreated's
    // cancelSessionEnd already ran for this id, so nothing would ever cancel
    // it and the LIVE session's ctx.state would be freed mid-conversation at
    // the end of the grace window.
    const sandbox = createSandbox(makeSandboxOptions());
    const ended: string[] = [];
    const first = makeSessionWs();
    sandbox.startSession(first.ws as never, { onSessionEnd: (sid) => ended.push(sid) });
    const configFrame = JSON.parse(
      (first.ws.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string,
    ) as { sessionId: string };
    const sid = configFrame.sessionId;

    // Socket drops; the reconnect lands BEFORE the old teardown settles.
    first.fire("close", { code: 1006, reason: "network blip" });
    const second = makeSessionWs();
    sandbox.startSession(second.ws as never, { resumeFrom: sid });
    // Now let the old session's async stop() settle — its late onSessionEnd
    // must be a no-op for this id (the resumed session owns the sink).
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toContain(sid);

    await vi.advanceTimersByTimeAsync(SESSION_RESUME_GRACE_MS + 1);
    expect(mockConn.sendNotification).not.toHaveBeenCalledWith("session/end", {
      sessionId: sid,
    });
    await sandbox.shutdown();
  });
});
