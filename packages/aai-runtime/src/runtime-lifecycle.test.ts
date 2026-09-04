// Copyright 2025 the AAI authors. MIT license.
// Runtime session lifecycle: shutdown, createSession/startSession wiring,
// custom runtime options, and session routing (S2S vs pipeline vs OpenAI
// Realtime). Tool-execution specs live in runtime.test.ts.

import { sessionSlot } from "@alexkroman1/aai";
import { SESSION_RESUME_GRACE_MS } from "@alexkroman1/aai/host-internal";
import type { S2sProvider } from "@alexkroman1/aai/s2s";
import { openAIS2s } from "@alexkroman1/aai/s2s";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { MockWebSocket } from "./_mock-ws.ts";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  FAKE_STT_API_KEY_ENV,
  FAKE_TTS_API_KEY_ENV,
  registerFakeProviders,
} from "./_pipeline-test-fakes.ts";
import {
  flush,
  makeAgent,
  makeClientSink,
  makeLogger,
  makeMockHandle,
  silentLogger,
  tick,
} from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import type { ConnectS2sOptions, S2sCallbacks } from "./s2s.ts";
import type { OpenaiRealtimeWebSocket } from "./transports/openai-realtime-transport.ts";
import { _internals } from "./transports/s2s-transport.ts";
import { asSessionWebSocket } from "./ws-handler.ts";

/**
 * An already-open socket for `startSession`. `MockWebSocket` rather than the
 * three-property literal this file used to hold: that one recorded no frames
 * and needed an `as never` per call. `asSessionWebSocket` is the repo's ONE
 * narrowing seam for this type (see `ws-frames.ts`).
 */
function openMockWs(): MockWebSocket {
  const ws = new MockWebSocket("ws://test");
  ws.readyState = MockWebSocket.OPEN;
  return ws;
}

describe("createRuntime shutdown", () => {
  test("shutdown stops active sessions gracefully", async () => {
    const mockHandle = makeMockHandle();
    const connectSpy = vi.spyOn(_internals, "connectS2s").mockResolvedValue(mockHandle);

    const runtime = createRuntime({ agent: makeAgent(), env: {}, logger: silentLogger });
    runtime.startSession(asSessionWebSocket(openMockWs()));

    await vi.waitFor(() => {
      expect(connectSpy).toHaveBeenCalled();
    });
    await flush();

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    // "Gracefully" means the provider link was CLOSED, not merely that
    // `shutdown()` returned. A bare 50 ms `sleep` stood here instead.
    expect(mockHandle.close).toHaveBeenCalled();
  });

  test("shutdown warns when a session stop rejects", async () => {
    const mockHandle = makeMockHandle();
    mockHandle.close = vi.fn(() => {
      throw new Error("close failed");
    });
    const connectSpy = vi.spyOn(_internals, "connectS2s").mockResolvedValue(mockHandle);

    // BOUND, not passed as a literal: the warn IS the behaviour under test, and
    // an unbound logger left `connectSpy` as the only assertion.
    const logger = makeLogger();
    const runtime = createRuntime({ agent: makeAgent(), env: {}, logger });
    runtime.startSession(asSessionWebSocket(openMockWs()));

    await vi.waitFor(() => {
      expect(connectSpy).toHaveBeenCalled();
    });
    await flush();

    await runtime.shutdown();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Session stop failed during shutdown"),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("close failed"));
  });

  test("shutdown warns on timeout when a session's stop hangs", async () => {
    // A hung stop needs something that really does not settle; this used a
    // no-op `close()` that returned at once, so the deadline never fired. Every
    // in-process path is guarded (a self-hosted tool call is `pTimeout`ed on
    // the reply's abort signal, the S2S stop is synchronous), so the honest
    // shape is SANDBOX mode's RPC executor — unwrapped, and a fair model of a
    // guest that stopped answering.
    let captured: S2sCallbacks | undefined;
    vi.spyOn(_internals, "connectS2s").mockImplementation(async (opts: ConnectS2sOptions) => {
      captured = opts.callbacks;
      return makeMockHandle();
    });

    const logger = makeLogger();
    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      logger,
      shutdownTimeoutMs: 50,
      toolSchemas: [
        { type: "function", name: "park", description: "never answers", parameters: {} },
      ],
      executeTool: () => new Promise<string>(() => undefined),
    });
    runtime.startSession(asSessionWebSocket(openMockWs()));

    await vi.waitFor(() => {
      expect(captured).toBeDefined();
    });
    // The session now owns a turn that never finishes, so only the deadline can
    // end it. The reply must be open first, or the tool call is refused.
    captured?.onReplyStarted("reply-1");
    captured?.onToolCall("call-1", "park", {});
    await flush();

    await runtime.shutdown();

    // The CONFIGURED deadline, echoed back: one dropped on the floor would have
    // waited out the 10 s default instead.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Shutdown timeout (50ms) exceeded"),
    );
  });

  test("state is not re-initialized when already present for session", async () => {
    const stateFactory = vi.fn(() => ({ counter: 0 }));
    const slot = sessionSlot("counter", stateFactory);
    const agent = makeAgent({
      tools: {
        increment: {
          description: "Increment counter",
          execute: (_args, ctx) => String(slot.update(ctx, (state) => ++state.counter)),
        },
        get_state: {
          description: "Get state",
          execute: (_args, ctx) => JSON.stringify(slot.get(ctx)),
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
    expect(typeof session.command).toBe("function");
    expect(typeof session.report).toBe("function");
    expect(typeof session.restoreHistory).toBe("function");
  });

  test("old session's delayed stop keeps the resumed session's sink and state", async () => {
    const slot = sessionSlot("counter", () => ({ counter: 0 }));
    const agent = makeAgent({
      tools: {
        ping: {
          description: "Ping the client and bump state",
          execute: (_args, ctx) => {
            const n = slot.update(ctx, (state) => ++state.counter);
            ctx.send("ping", { n });
            return String(n);
          },
        },
      },
    });
    const runtime = createRuntime({ agent, env: {}, logger: silentLogger });

    const oldClient = makeClientSink();
    const oldSession = runtime.createSession({
      id: "resume-1",
      agent: agent.name,
      client: oldClient,
    });

    // Reconnect resumes the same id while the old session is still tearing
    // down: the new session registers its sink/state under the same key.
    const newClient = makeClientSink();
    runtime.createSession({ id: "resume-1", agent: agent.name, client: newClient });
    await runtime.executeTool("ping", {}, "resume-1", []);

    // The old session's stop settles AFTER the resume — its cleanup must not
    // wipe the new session's sink (ctx.send would no-op) or tool state.
    await oldSession.stop();

    const result = await runtime.executeTool("ping", {}, "resume-1", []);
    expect(result).toBe("2");
    expect(newClient.event).toHaveBeenCalledWith(
      expect.objectContaining({ type: "custom.emitted", event: "ping", data: { n: 2 } }),
    );
  });

  test("ctx.send drops an over-cap payload but relays an under-cap one", async () => {
    const agent = makeAgent({
      tools: {
        emit: {
          description: "Send a client event of a caller-chosen size",
          inputSchema: z.object({ size: z.number() }),
          execute: (args, ctx) => {
            ctx.send("big", { blob: "x".repeat((args as { size: number }).size) });
            return "sent";
          },
        },
      },
    });
    const runtime = createRuntime({ agent, env: {}, logger: silentLogger });
    const client = makeClientSink();
    runtime.createSession({ id: "s1", agent: agent.name, client });

    // Over the 64 KB payload cap → dropped (the guest→host relay used to do
    // this; the runtime now owns it since ctx.send runs in-guest).
    await runtime.executeTool("emit", { size: 70_000 }, "s1", []);
    expect(client.event).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "custom.emitted" }),
    );

    // Comfortably under → relayed.
    await runtime.executeTool("emit", { size: 10 }, "s1", []);
    expect(client.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "custom.emitted",
        event: "big",
        data: { blob: "x".repeat(10) },
      }),
    );
  });

  test("ctx.send drops an unserializable payload instead of failing the tool call", async () => {
    // `JSON.stringify` throws on a cycle and returns undefined for a function —
    // and this runs on the TOOL's own stack, so the throw failed the whole call:
    // the model was told the tool failed and the state it had already mutated
    // was reported as a failure, for a notification the cap logic above already
    // treats as droppable.
    const agent = makeAgent({
      tools: {
        emit: {
          description: "Send a payload that has no JSON form",
          inputSchema: z.object({ kind: z.string() }),
          execute: (args, ctx) => {
            if ((args as { kind: string }).kind === "cycle") {
              const cyclic: Record<string, unknown> = {};
              cyclic.self = cyclic;
              ctx.send("bad", cyclic);
            } else {
              ctx.send("bad", () => "not JSON");
            }
            return "sent";
          },
        },
      },
    });
    const runtime = createRuntime({ agent, env: {}, logger: silentLogger });
    const client = makeClientSink();
    runtime.createSession({ id: "s-unserializable", agent: agent.name, client });

    for (const kind of ["cycle", "function"]) {
      // The tool's own result, not a serialized failure.
      expect(await runtime.executeTool("emit", { kind }, "s-unserializable", [])).toBe("sent");
    }
    expect(client.event).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "custom.emitted" }),
    );
  });

  test("resume after the old session fully stopped keeps its slot state (grace window)", async () => {
    const slot = sessionSlot("counter", () => ({ counter: 0 }));
    const agent = makeAgent({
      tools: {
        increment: {
          description: "Bump state",
          execute: (_args, ctx) => String(slot.update(ctx, (state) => ++state.counter)),
        },
      },
    });
    const runtime = createRuntime({ agent, env: {}, logger: silentLogger });

    const oldSession = runtime.createSession({
      id: "resume-2",
      agent: agent.name,
      client: makeClientSink(),
    });
    await runtime.executeTool("increment", {}, "resume-2", []);

    // The common resume shape: the old session's stop settles BEFORE the
    // client reconnects (backoff starts at 1s). ctx.state must survive the
    // gap — the grace-window sweep, not the stop, reclaims it.
    await oldSession.stop();

    runtime.createSession({ id: "resume-2", agent: agent.name, client: makeClientSink() });
    const result = await runtime.executeTool("increment", {}, "resume-2", []);
    expect(result).toBe("2");
  });

  test("unresumed session state is reclaimed after the grace window", async () => {
    // Only fake the timeout APIs: the tool executor yields via setImmediate,
    // which must keep running for executeTool to settle.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stateFactory = vi.fn(() => ({ counter: 0 }));
      const slot = sessionSlot("counter", stateFactory);
      const agent = makeAgent({
        tools: {
          increment: {
            description: "Bump state",
            execute: (_args, ctx) => String(slot.update(ctx, (state) => ++state.counter)),
          },
        },
      });
      const runtime = createRuntime({ agent, env: {}, logger: silentLogger });

      const session = runtime.createSession({
        id: "expire-1",
        agent: agent.name,
        client: makeClientSink(),
      });
      await runtime.executeTool("increment", {}, "expire-1", []);
      await session.stop();

      // No resume arrives — after the grace window the state is gone and a
      // later session under the same id starts fresh.
      await vi.advanceTimersByTimeAsync(SESSION_RESUME_GRACE_MS + 1);

      runtime.createSession({ id: "expire-1", agent: agent.name, client: makeClientSink() });
      const result = await runtime.executeTool("increment", {}, "expire-1", []);
      expect(result).toBe("1");
      expect(stateFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Start a pipeline-mode session with a greeting configured and hand back what
   * it spoke. The greeting is the only thing `skipGreeting` changes, and the
   * AssemblyAI S2S transport is never handed the flag at all — so the pipeline
   * is the branch where the runtime's forwarding of it is observable.
   */
  async function startGreetingSession(sessionOpts: { skipGreeting?: boolean }) {
    const stt = createFakeSttProvider();
    const tts = createFakeTtsProvider();
    const llm = createFakeLanguageModel({ script: [] });
    const fakes = registerFakeProviders({ stt, tts, llm });
    const runtime = createRuntime({
      agent: makeAgent({ greeting: "Hello there." }),
      env: { ...fakes.env, [FAKE_STT_API_KEY_ENV]: "stt-key", [FAKE_TTS_API_KEY_ENV]: "tts-key" },
      logger: silentLogger,
      stt: fakes.stt,
      llm: fakes.llm,
      tts: fakes.tts,
    });
    const session = runtime.createSession({
      id: `greet-${sessionOpts.skipGreeting === true}`,
      agent: "test-agent",
      client: makeClientSink(),
      ...sessionOpts,
    });
    await session.start();
    return { tts, stop: () => session.stop().finally(fakes.unregister) };
  }

  test("createSession's skipGreeting reaches the transport", async () => {
    // Dropping this option is the silent-config-drop class: the session still
    // works, and every reconnect repeats a line the caller already heard.
    const greeting = await startGreetingSession({});
    await vi.waitFor(() => {
      expect(greeting.tts.last()?.textChunks.join("")).toContain("Hello there.");
    });
    await greeting.stop();

    const resumed = await startGreetingSession({ skipGreeting: true });
    await tick(); // the same settling the positive case needed above
    await tick();
    expect(resumed.tts.last()?.textChunks ?? []).toEqual([]);
    await resumed.stop();
  });
});

describe("createRuntime startSession", () => {
  test("startSession forwards resumeFrom, logContext and the open/close hooks", async () => {
    vi.spyOn(_internals, "connectS2s").mockResolvedValue(makeMockHandle());
    const logger = makeLogger();
    const runtime = createRuntime({ agent: makeAgent(), env: {}, logger });
    // CONNECTING, so the `open` listener has to actually fire — the old version
    // asserted only that SOME listener had been registered.
    const ws = new MockWebSocket("ws://test");
    const onOpen = vi.fn();
    const onClose = vi.fn();

    runtime.startSession(asSessionWebSocket(ws), {
      skipGreeting: true,
      resumeFrom: "prev-session",
      logContext: { userId: "u1" },
      onOpen,
      onClose,
    });

    await vi.waitFor(() => {
      expect(onOpen).toHaveBeenCalled();
    });
    // `resumeFrom` IS the id this connection continues under, and the handshake
    // frame is how the client learns it: dropped, the resume silently becomes a
    // new conversation under a fresh UUID.
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: "session.configured", sessionId: "prev-session" }),
    );
    // `logContext` rides on every line this connection logs.
    expect(logger.info).toHaveBeenCalledWith(
      "Session connected",
      expect.objectContaining({ userId: "u1" }),
    );

    ws.close();
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  test("startSession with no options mints a fresh session id", async () => {
    vi.spyOn(_internals, "connectS2s").mockResolvedValue(makeMockHandle());
    const runtime = createRuntime({ agent: makeAgent(), env: {}, logger: silentLogger });
    const ws = new MockWebSocket("ws://test");

    runtime.startSession(asSessionWebSocket(ws));

    await vi.waitFor(() => {
      expect(ws.sentJson()).toContainEqual(expect.objectContaining({ type: "session.configured" }));
    });
    const configured = ws.sentJson().find((frame) => frame.type === "session.configured") as {
      sessionId: string;
    };
    expect(configured.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("createRuntime with custom options", () => {
  test("a custom sessionStartTimeoutMs bounds a start that never resolves", async () => {
    // The only thing between a wedged provider and a client stuck "connecting"
    // for the 10 s default, so the deadline it configures must be the one used.
    vi.spyOn(_internals, "connectS2s").mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    const logger = makeLogger();
    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      logger,
      sessionStartTimeoutMs: 50,
    });

    runtime.startSession(asSessionWebSocket(new MockWebSocket("ws://test")));

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        "Session start failed",
        expect.objectContaining({
          error: expect.stringContaining("session.start() timed out after 50ms"),
        }),
      );
    });
  });

  test("a custom createWebSocket is dialled, carrying ASSEMBLYAI_API_KEY", async () => {
    // Both options asserted by USE rather than by forwarding — each of them
    // used to be a `expect(runtime).toBeDefined()`. A runtime that accepted the
    // factory and dialled its own socket, or that read the credential from
    // somewhere other than the agent env, looks identical from the options
    // object. The socket is constructed INSIDE the factory because
    // `MockWebSocket` opens on the next microtask: one built earlier opens
    // before `connectS2s` has its listener on and the handshake never completes.
    const createWebSocket = vi.fn(() => new MockWebSocket("wss://fake"));
    const runtime = createRuntime({
      agent: makeAgent(),
      env: { ASSEMBLYAI_API_KEY: "sk-custom" },
      logger: silentLogger,
      createWebSocket,
    });
    const session = runtime.createSession({
      id: "custom-ws",
      agent: "test-agent",
      client: makeClientSink(),
    });

    await session.start();

    expect(createWebSocket).toHaveBeenCalledWith(
      expect.stringContaining("wss://"),
      expect.objectContaining({ headers: { Authorization: "Bearer sk-custom" } }),
    );
    await session.stop();
  });

  test("an untouched slot reads as its own default, not as an empty bag", async () => {
    // There is no bag: a session that has run no tool has no state at all, and
    // the value a first read sees comes from the slot's own factory.
    const slot = sessionSlot("shape", () => ({ ready: true }));
    const agent = makeAgent({
      tools: {
        get_state: {
          description: "Get state",
          execute: (_args, ctx) => JSON.stringify(slot.get(ctx)),
        },
      },
    });
    const runtime = createRuntime({ agent, env: {} });
    const result = await runtime.executeTool("get_state", {}, "s1", []);
    expect(JSON.parse(result)).toEqual({ ready: true });
  });
});

describe("Runtime — session routing", () => {
  test("manifest with stt/llm/tts routes to PipelineSession (no S2S socket opened)", async () => {
    const createWebSocket = vi.fn();
    const stt = createFakeSttProvider();
    const tts = createFakeTtsProvider();
    // Registered as provider kinds, so resolution — including which env var each
    // credential comes from — runs exactly as it does for a real provider.
    const fakes = registerFakeProviders({ stt, tts, llm: createFakeLanguageModel({ script: [] }) });

    const runtime = createRuntime({
      agent: makeAgent(),
      env: { ...fakes.env, [FAKE_STT_API_KEY_ENV]: "stt-key", [FAKE_TTS_API_KEY_ENV]: "tts-key" },
      logger: silentLogger,
      createWebSocket,
      stt: fakes.stt,
      llm: fakes.llm,
      tts: fakes.tts,
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
    expect(stt.last()?.options.apiKey).toBe("stt-key");
    expect(tts.last()?.options.apiKey).toBe("tts-key");

    await session.stop();
    fakes.unregister();
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
  });

  test("agent.s2s = openAIS2s() routes to OpenAI Realtime transport", async () => {
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
      agent: makeAgent({ s2s: openAIS2s({ model: "gpt-realtime" }) }),
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
    // `start()` hydrates this session's slot state before it opens anything, so
    // the socket is constructed a microtask later than it used to be — waiting
    // for the constructor rather than assuming it already ran.
    await vi.waitFor(() => expect(createOpenaiRealtimeWebSocket).toHaveBeenCalled());
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
