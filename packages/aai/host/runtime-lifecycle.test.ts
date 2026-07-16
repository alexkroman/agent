// Copyright 2025 the AAI authors. MIT license.
// Runtime session lifecycle: shutdown, createSession/startSession wiring,
// custom runtime options, and session routing (S2S vs pipeline vs OpenAI
// Realtime). Tool-execution specs live in runtime.test.ts.

import { afterEach, describe, expect, test, vi } from "vitest";
import { openaiRealtime } from "../sdk/providers/s2s/openai-realtime.ts";
import type { S2sProvider } from "../sdk/providers.ts";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
} from "./_pipeline-test-fakes.ts";
import { flush, makeAgent, makeClientSink, makeMockHandle, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import type { OpenaiRealtimeWebSocket } from "./transports/openai-realtime-transport.ts";
import { _internals } from "./transports/s2s-transport.ts";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeMockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
    addEventListener: vi.fn(),
  };
}

describe("createRuntime shutdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("shutdown stops active sessions gracefully", async () => {
    const mockHandle = makeMockHandle();
    const connectSpy = vi.spyOn(_internals, "connectS2s").mockResolvedValue(mockHandle);

    const runtime = createRuntime({ agent: makeAgent(), env: {}, logger: silentLogger });
    runtime.startSession(makeMockWs() as never);

    await vi.waitFor(() => {
      expect(connectSpy).toHaveBeenCalled();
    });
    await flush();
    await new Promise((r) => setTimeout(r, 50));

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    connectSpy.mockRestore();
  });

  test("shutdown warns when a session stop rejects", async () => {
    const mockHandle = makeMockHandle();
    mockHandle.close = vi.fn(() => {
      throw new Error("close failed");
    });
    const connectSpy = vi.spyOn(_internals, "connectS2s").mockResolvedValue(mockHandle);

    const runtime = createRuntime({ agent: makeAgent(), env: {}, logger: makeLogger() });
    runtime.startSession(makeMockWs() as never);

    await vi.waitFor(() => {
      expect(connectSpy).toHaveBeenCalled();
    });
    await flush();

    await runtime.shutdown();
    connectSpy.mockRestore();
  });

  test("shutdown warns on timeout when sessions hang", async () => {
    const mockHandle = makeMockHandle();
    mockHandle.close = vi.fn(() => {
      /* no-op */
    });
    const connectSpy = vi.spyOn(_internals, "connectS2s").mockResolvedValue(mockHandle);

    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      logger: makeLogger(),
      shutdownTimeoutMs: 50,
    });
    runtime.startSession(makeMockWs() as never);

    await vi.waitFor(() => {
      expect(connectSpy).toHaveBeenCalled();
    });
    await flush();

    await runtime.shutdown();
    connectSpy.mockRestore();
  });

  test("state is not re-initialized when already present for session", async () => {
    const stateFactory = vi.fn(() => ({ counter: 0 }));
    const agent = makeAgent({
      state: stateFactory,
      tools: {
        increment: {
          description: "Increment counter",
          execute: (_args, ctx) => {
            const state = ctx.state as { counter: number };
            state.counter++;
            return String(state.counter);
          },
        },
        get_state: {
          description: "Get state",
          execute: (_args, ctx) => JSON.stringify(ctx.state),
        },
      },
    });
    const runtime = createRuntime({ agent, env: {} });

    await runtime.executeTool("increment", {}, "s1", []);
    await runtime.executeTool("increment", {}, "s1", []);
    const result = await runtime.executeTool("get_state", {}, "s1", []);
    expect(JSON.parse(result)).toEqual({ counter: 2 });
    expect(stateFactory).toHaveBeenCalledTimes(1);
  });
});

describe("createRuntime createSession", () => {
  test("createSession returns a Session object", () => {
    const agent = makeAgent();
    const runtime = createRuntime({ agent, env: {} });
    const client = makeClientSink();
    const session = runtime.createSession({
      id: "test-session",
      agent: agent.name,
      client,
    });
    expect(session).toBeDefined();
    expect(typeof session.start).toBe("function");
    expect(typeof session.stop).toBe("function");
    expect(typeof session.onAudio).toBe("function");
    expect(typeof session.onCancel).toBe("function");
    expect(typeof session.onReset).toBe("function");
    expect(typeof session.onHistory).toBe("function");
  });

  test("createSession passes skipGreeting option", () => {
    const agent = makeAgent();
    const runtime = createRuntime({ agent, env: {} });
    const client = makeClientSink();
    const session = runtime.createSession({
      id: "test-session",
      agent: agent.name,
      client,
      skipGreeting: true,
    });
    expect(session).toBeDefined();
  });
});

describe("createRuntime startSession", () => {
  test("startSession wires WebSocket and passes options", () => {
    const runtime = createRuntime({ agent: makeAgent(), env: {}, logger: silentLogger });
    const ws = makeMockWs();

    runtime.startSession(ws as never, {
      skipGreeting: true,
      resumeFrom: "prev-session",
      logContext: { userId: "u1" },
      onOpen: vi.fn(),
      onClose: vi.fn(),
    });

    expect(ws.addEventListener).toHaveBeenCalled();
  });

  test("startSession works with no options", () => {
    const runtime = createRuntime({ agent: makeAgent(), env: {}, logger: silentLogger });
    const ws = makeMockWs();

    runtime.startSession(ws as never);
    expect(ws.addEventListener).toHaveBeenCalled();
  });
});

describe("createRuntime with custom options", () => {
  test("accepts custom sessionStartTimeoutMs", () => {
    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      sessionStartTimeoutMs: 5000,
    });
    expect(runtime).toBeDefined();
  });

  test("accepts custom createWebSocket", () => {
    const createWebSocket = vi.fn();
    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      createWebSocket,
    });
    expect(runtime).toBeDefined();
  });

  test("uses ASSEMBLYAI_API_KEY from env for sessions", () => {
    const agent = makeAgent();
    const runtime = createRuntime({
      agent,
      env: { ASSEMBLYAI_API_KEY: "test-api-key" },
    });
    const client = makeClientSink();
    const session = runtime.createSession({
      id: "test-session",
      agent: agent.name,
      client,
    });
    expect(session).toBeDefined();
  });

  test("default state is empty object when agent has no state factory", async () => {
    const agent = makeAgent({
      tools: {
        get_state: {
          description: "Get state",
          execute: (_args, ctx) => JSON.stringify(ctx.state),
        },
      },
    });
    const runtime = createRuntime({ agent, env: {} });
    const result = await runtime.executeTool("get_state", {}, "s1", []);
    expect(JSON.parse(result)).toEqual({});
  });
});

describe("Runtime — session routing", () => {
  test("manifest with stt/llm/tts routes to PipelineSession (no S2S socket opened)", async () => {
    const createWebSocket = vi.fn();
    const stt = createFakeSttProvider();
    const tts = createFakeTtsProvider();
    const llm = createFakeLanguageModel({ script: [] });

    const runtime = createRuntime({
      agent: makeAgent(),
      env: { ASSEMBLYAI_API_KEY: "stt-key", CARTESIA_API_KEY: "tts-key" },
      logger: silentLogger,
      createWebSocket,
      stt,
      llm,
      tts,
    });

    const client = makeClientSink();
    const session = runtime.createSession({
      id: "sess-pipeline",
      agent: "test-agent",
      client,
    });

    expect(typeof session.start).toBe("function");
    expect(typeof session.stop).toBe("function");

    // Opening providers drives the pipeline path end-to-end; the S2S WS factory
    // must never be called for a pipeline-mode session.
    await session.start();
    expect(stt.last()).toBeDefined();
    expect(tts.last()).toBeDefined();
    expect(createWebSocket).not.toHaveBeenCalled();

    // Pipeline providers saw the resolved host-side credentials.
    expect(stt.last()?.opts.apiKey).toBe("stt-key");
    expect(tts.last()?.opts.apiKey).toBe("tts-key");

    await session.stop();
  });

  test("manifest without stt/llm/tts routes to S2sSession (createWebSocket IS called)", async () => {
    const mockHandle = makeMockHandle();
    const connectSpy = vi.spyOn(_internals, "connectS2s").mockResolvedValue(mockHandle);

    const createWebSocket = vi.fn();
    const runtime = createRuntime({
      agent: makeAgent(),
      env: { ASSEMBLYAI_API_KEY: "s2s-key" },
      logger: silentLogger,
      createWebSocket,
    });

    const client = makeClientSink();
    const session = runtime.createSession({
      id: "sess-s2s",
      agent: "test-agent",
      client,
    });

    await session.start();
    // connectS2s is the seam that consumes our createWebSocket factory inside
    // the S2S path. If routing picked the pipeline branch this would never fire.
    expect(connectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ createWebSocket, apiKey: "s2s-key" }),
    );

    await session.stop();
    connectSpy.mockRestore();
  });

  test("agent.s2s = openaiRealtime() routes to OpenAI Realtime transport", async () => {
    type Listener = (ev: unknown) => void;
    const listeners: Record<string, Listener[]> = {
      open: [],
      message: [],
      close: [],
      error: [],
    };
    const fakeWs: OpenaiRealtimeWebSocket = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: ((type: string, fn: Listener) => {
        (listeners[type] ?? []).push(fn);
      }) as OpenaiRealtimeWebSocket["addEventListener"],
    };
    let capturedUrl: string | null = null;
    let capturedOpts: { headers: Record<string, string> } | null = null;
    const createOpenaiRealtimeWebSocket = vi.fn(
      (url: string, wsOpts: { headers: Record<string, string> }) => {
        capturedUrl = url;
        capturedOpts = wsOpts;
        return fakeWs;
      },
    );

    const runtime = createRuntime({
      agent: makeAgent({ s2s: openaiRealtime({ model: "gpt-realtime" }) }),
      env: { OPENAI_API_KEY: "sk-test" },
      logger: silentLogger,
      createOpenaiRealtimeWebSocket,
    });

    const client = makeClientSink();
    const session = runtime.createSession({
      id: "sess-openai-realtime",
      agent: "test-agent",
      client,
    });

    const startP = session.start();
    // Drive the WS open so transport.start() resolves
    for (const fn of listeners.open ?? []) fn(undefined);
    await startP;

    expect(createOpenaiRealtimeWebSocket).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toContain("api.openai.com");
    expect(capturedUrl).toContain("model=gpt-realtime");
    expect(capturedOpts).toMatchObject({
      headers: { Authorization: "Bearer sk-test" },
    });

    await session.stop();
  });

  test("createSession throws on unknown s2s provider kind", () => {
    const runtime = createRuntime({
      agent: makeAgent({
        // Bypass typing for this test — descriptor with unrecognized kind:
        s2s: { kind: "made-up-provider", options: {} } as unknown as S2sProvider,
      }),
      env: {},
      logger: silentLogger,
    });

    expect(() =>
      runtime.createSession({
        id: "sess-bad",
        agent: "test-agent",
        client: makeClientSink(),
      }),
    ).toThrow(/Unknown s2s provider kind/);
  });
});
