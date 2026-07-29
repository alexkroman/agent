// Copyright 2025 the AAI authors. MIT license.
/**
 * Behavioral tests for createSandbox's startSession wrapper: it must
 * register each session's client sink (so guest client/send events reach
 * the client) and tear everything down on session end (deregister the sink,
 * notify the guest with session/end, and still run the caller's own hooks).
 *
 * Split from sandbox.test.ts, which is at the test-file length cap.
 */

import { describe, expect, it, vi } from "vitest";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { createSandbox } from "./sandbox.ts";
import { createTestStorage } from "./test-utils.ts";

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

vi.mock("./sandbox-vm.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./sandbox-vm.ts")>();
  return { ...orig, createSandboxVm: mockCreateSandboxVm };
});

/**
 * The runtime's own startSession, replaced with a recording stub: this file
 * never opens real WebSocket sessions, and the stub's captured options let
 * the test drive the wrapper's session-lifecycle hooks directly.
 */
const capturedStartSession: { current: ReturnType<typeof vi.fn> | null } = { current: null };

vi.mock("@alexkroman1/aai/runtime", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@alexkroman1/aai/runtime")>();
  return {
    ...orig,
    createRuntime(opts: Parameters<typeof orig.createRuntime>[0]) {
      const runtime = orig.createRuntime(opts);
      const startSession = vi.fn();
      capturedStartSession.current = startSession;
      return { ...runtime, startSession };
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

describe("startSession wrapper session cleanup", () => {
  it("registers the session's sink and tears it down on session end", async () => {
    const sandbox = createSandbox({
      workerCode: 'export default { name: "test" };',
      env: {},
      storage: createTestStorage(),
      slug: "test-agent",
      agentConfig: TEST_AGENT_CONFIG,
    });

    // Wait for the vmReady .then() to register the client/send handler.
    await vi.waitFor(() => {
      expect(mockConn.onNotification).toHaveBeenCalledWith("client/send", expect.any(Function));
    });
    const onNotification = vi.mocked(mockConn.onNotification);
    const clientSend = onNotification.mock.calls.find((c) => c[0] === "client/send")?.[1] as (
      raw: unknown,
    ) => void;

    const userOnSinkCreated = vi.fn();
    const userOnSessionEnd = vi.fn();
    const fakeWs = { readyState: 0, send: vi.fn(), addEventListener: vi.fn() };
    sandbox.startSession(fakeWs as Parameters<typeof sandbox.startSession>[0], {
      onSinkCreated: userOnSinkCreated,
      onSessionEnd: userOnSessionEnd,
    });

    // The wrapper delegates to the runtime with instrumented lifecycle hooks.
    const startSession = capturedStartSession.current;
    if (!startSession) throw new Error("runtime startSession was not captured");
    expect(startSession).toHaveBeenCalledOnce();
    const wrapped = startSession.mock.calls[0]?.[1] as {
      onSinkCreated: (sessionId: string, sink: unknown) => void;
      onSessionEnd: (sessionId: string) => void;
    };

    // Session starts: the sink is registered, so guest client/send events
    // for this session reach it — and the user's own hook still fires.
    const sink = { open: true, event: vi.fn(), playAudioChunk: vi.fn(), playAudioDone: vi.fn() };
    wrapped.onSinkCreated("s1", sink);
    expect(userOnSinkCreated).toHaveBeenCalledWith("s1", sink);
    clientSend({ sessionId: "s1", event: "ping", data: 1 });
    expect(sink.event).toHaveBeenCalledOnce();

    // Session ends: guest is told, the user's hook fires, and the sink is
    // deregistered — further guest events for the session go nowhere.
    wrapped.onSessionEnd("s1");
    expect(userOnSessionEnd).toHaveBeenCalledWith("s1");
    await vi.waitFor(() => {
      expect(mockConn.sendNotification).toHaveBeenCalledWith("session/end", { sessionId: "s1" });
    });
    clientSend({ sessionId: "s1", event: "ping", data: 2 });
    expect(sink.event).toHaveBeenCalledOnce();

    await sandbox.shutdown();
  });
});
