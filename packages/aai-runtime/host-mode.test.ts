// Copyright 2026 the AAI authors. MIT license.

import { createOwnedMap } from "@alexkroman1/aai/host-internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { assemblyAIS2s } from "@alexkroman1/aai/s2s";
import { describe, expect, test, vi } from "vitest";
import { MockWebSocket } from "./_mock-ws.ts";
import { flush, makeConfig, makeEmitter, makeLogger, silentLogger } from "./_test-utils.ts";
import { UNPACED_AUDIO_LEAD_MS } from "./audio-pacer.ts";
import {
  buildHostAgent,
  DEFAULT_HOST_MAX_STEPS,
  isHostAllowed,
  startHostSession,
  unknownCredentialName,
  withHostCredentials,
} from "./host-mode.ts";
import { createRelayExecuteTool } from "./host-relay.ts";
import type { Runtime, RuntimeOptions } from "./runtime.ts";
import { createSessionCore } from "./session-core.ts";
import type { Transport } from "./transports/types.ts";
import type { SessionWebSocket } from "./ws-handler.ts";
import { wireSessionSocket } from "./ws-handler.ts";

const TOOL_SCHEMA: ToolSchema = {
  type: "function",
  name: "lookup",
  description: "Look something up",
  parameters: {},
};

function hostConfigFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "config",
    host: { systemPrompt: "You are a host agent.", greeting: "Hi.", tools: [TOOL_SCHEMA] },
    sampleRate: 8000,
    ttsSampleRate: 16_000,
    ...overrides,
  });
}

function makeFakeRuntime(o: RuntimeOptions): {
  runtime: Runtime;
  startSession: ReturnType<typeof vi.fn>;
} {
  const startSession = vi.fn();
  const runtime = {
    startSession,
    shutdown: vi.fn(() => Promise.resolve()),
    readyConfig: { audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 },
    executeTool: o.executeTool ?? (() => Promise.resolve("")),
    toolSchemas: o.toolSchemas ?? [],
    createSession: vi.fn(),
  } as unknown as Runtime;
  return { runtime, startSession };
}

function makeFakeTransport(): Transport {
  return {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    sendUserAudio: vi.fn(),
    sendToolResult: vi.fn(),
    cancelReply: vi.fn(),
  };
}

function openMockWs(): MockWebSocket {
  const ws = new MockWebSocket("ws://test");
  ws.readyState = MockWebSocket.OPEN;
  return ws;
}

/**
 * `MockWebSocket` implements the slice of the socket contract the host
 * session actually touches, but it does not structurally satisfy
 * `SessionWebSocket`. Narrow at this one seam rather than at every
 * `startHostSession` call; the escape-hatch ratchet counts each occurrence.
 */
function asSessionWs(ws: MockWebSocket): SessionWebSocket {
  return ws as unknown as SessionWebSocket;
}

describe("isHostAllowed", () => {
  // Host mode lets an unauthenticated client replace the agent definition and
  // spend the operator's provider credentials, so it must be opt-in: an unset
  // or unrecognized value leaves it off.
  test("defaults to disabled when unset or empty", () => {
    expect(isHostAllowed({})).toBe(false);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "" })).toBe(false);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "   " })).toBe(false);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "maybe" })).toBe(false);
  });

  test("enabled for 1/true (case-insensitive)", () => {
    expect(isHostAllowed({ AAI_ALLOW_HOST: "1" })).toBe(true);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "true" })).toBe(true);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "TRUE" })).toBe(true);
  });

  test("disabled for 0/false", () => {
    expect(isHostAllowed({ AAI_ALLOW_HOST: "0" })).toBe(false);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "false" })).toBe(false);
    expect(isHostAllowed({ AAI_ALLOW_HOST: "False" })).toBe(false);
  });
});

describe("host-supplied credentials", () => {
  test.each([
    ["ASSEMBLYAI_API_KEY", undefined],
    ["OPENAI_API_KEY", undefined],
    ["CARTESIA_API_KEY", undefined],
    // The two that make the allowlist load-bearing rather than tidy: one
    // would repoint ctx.db at a Postgres the client owns, the other would
    // let an unapproved client approve itself.
    ["DATABASE_URL", "DATABASE_URL"],
    ["AAI_ALLOW_HOST", "AAI_ALLOW_HOST"],
    ["ASSEMBLYAI_KEY", "ASSEMBLYAI_KEY"],
  ])("%s → rejected name %s", (name, expected) => {
    expect(unknownCredentialName({ [name]: "v" })).toBe(expected);
  });

  test("absent or empty credentials are allowed", () => {
    expect(unknownCredentialName(undefined)).toBeUndefined();
    expect(unknownCredentialName({})).toBeUndefined();
  });

  test("reports a rejected name even when allowed ones accompany it", () => {
    expect(unknownCredentialName({ ASSEMBLYAI_API_KEY: "a", DATABASE_URL: "b" })).toBe(
      "DATABASE_URL",
    );
  });

  test("client credentials win over the server's own", () => {
    expect(
      withHostCredentials(
        { ASSEMBLYAI_API_KEY: "operator", DATABASE_URL: "postgres://operator" },
        { ASSEMBLYAI_API_KEY: "tenant" },
      ),
    ).toEqual({ ASSEMBLYAI_API_KEY: "tenant", DATABASE_URL: "postgres://operator" });
  });

  test("no credentials leaves the server env untouched", () => {
    const env = { ASSEMBLYAI_API_KEY: "operator" };
    expect(withHostCredentials(env, undefined)).toBe(env);
  });
});

describe("buildHostAgent", () => {
  test("maps systemPrompt/greeting and relays tools (no in-process tool defs)", () => {
    const agent = buildHostAgent({
      systemPrompt: "You are helpful.",
      greeting: "Hi there.",
      tools: [{ type: "function", name: "get_time", description: "Get the time", parameters: {} }],
    });
    expect(agent.systemPrompt).toBe("You are helpful.");
    expect(agent.greeting).toBe("Hi there.");
    // Host tools are relayed, not real ToolDefs, so the synthetic agent has none.
    expect(agent.tools).toEqual({});
    expect(agent.maxSteps).toBe(DEFAULT_HOST_MAX_STEPS);
  });

  test("the operator's maxSteps survives; the host default only fills an unset one", () => {
    // `createHostServer({ defaults: { maxSteps } })` reaches here as the base
    // agent, and `HostSessionDefaults` admits the field explicitly. It used to
    // be overwritten by the host default on the line after the spread, so every
    // tenant ran 30 steps whatever the operator configured — and the assertion
    // that was here (`typeof agent.maxSteps === "number"`) held either way.
    const base = { name: "deployed", systemPrompt: "base", greeting: "", maxSteps: 5, tools: {} };
    expect(buildHostAgent({ systemPrompt: "P", tools: [] }, base).maxSteps).toBe(5);
    const { maxSteps: _drop, ...noSteps } = base;
    expect(buildHostAgent({ systemPrompt: "P", tools: [] }, noSteps as typeof base).maxSteps).toBe(
      DEFAULT_HOST_MAX_STEPS,
    );
  });

  test("defaults greeting to empty string when omitted", () => {
    const agent = buildHostAgent({ systemPrompt: "P", tools: [] });
    expect(agent.greeting).toBe("");
  });

  test("carries the host block's sttPrompt so the client can bias transcription", () => {
    // A host-mode client owns the task vocabulary (spelled-out order IDs,
    // product codes) but could previously only steer the LLM, not the STT —
    // leaving the pipeline to transcribe domain identifiers unbiased.
    const agent = buildHostAgent({
      systemPrompt: "P",
      tools: [],
      sttPrompt: "Identifiers are read letter by letter, e.g. 'P O 999'.",
    });
    expect(agent.sttPrompt).toBe("Identifiers are read letter by letter, e.g. 'P O 999'.");
  });

  test("host sttPrompt overrides the base agent's, and the base value survives when omitted", () => {
    const base = {
      name: "deployed",
      systemPrompt: "base",
      sttPrompt: "base terms",
      greeting: "",
      maxSteps: 5,
      tools: {},
    };
    expect(
      buildHostAgent({ systemPrompt: "P", tools: [], sttPrompt: "host terms" }, base).sttPrompt,
    ).toBe("host terms");
    // Omitted in the host block → the operator's configured prompt stands, the
    // same inheritance rule the provider triple follows.
    expect(buildHostAgent({ systemPrompt: "P", tools: [] }, base).sttPrompt).toBe("base terms");
  });
});

describe("startHostSession (deferred host handshake)", () => {
  test("first config.host frame builds a host runtime from the block and starts the session", async () => {
    const ws = openMockWs();
    let captured: RuntimeOptions | undefined;
    let startSession: ReturnType<typeof vi.fn> = vi.fn();

    startHostSession(asSessionWs(ws), {
      // Host mode is opt-in, so the happy path must enable it explicitly.
      env: { AAI_ALLOW_HOST: "1" },
      logger: silentLogger,
      createRuntime: (o) => {
        captured = o;
        const fake = makeFakeRuntime(o);
        startSession = fake.startSession;
        return fake.runtime;
      },
    });

    ws.simulateMessage(hostConfigFrame());
    // The env is awaited (it may be a pending Vault fetch); a plain object
    // resolves on the next microtask.
    await flush();

    // Synthetic agent built from the host block.
    expect(captured?.agent.systemPrompt).toBe("You are a host agent.");
    expect(captured?.agent.greeting).toBe("Hi.");
    // Relay wiring: executeTool + toolSchemas + onToolResult all injected.
    expect(captured?.toolSchemas).toEqual([TOOL_SCHEMA]);
    expect(typeof captured?.executeTool).toBe("function");
    expect(typeof captured?.onToolResult).toBe("function");
    // Client-requested sample rates flow into the S2S config (requirement 5).
    expect(captured?.s2sConfig).toMatchObject({ inputSampleRate: 8000, outputSampleRate: 16_000 });
    // Session started on the fresh per-connection runtime, deferred to the frame.
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession.mock.calls[0]?.[0]).toBe(ws);
  });

  /**
   * Audio pacing is the CLIENT'S declaration, and it defaults to paced.
   *
   * Unpaced used to be the blanket default here, reasoning that a host-mode
   * client is programmatic and therefore keeps its own clock. Being programmatic
   * does not imply consuming faster than real time: in S2S mode the service
   * synthesises a whole reply server-side and it arrives in one burst, so
   * unpaced relay handed the tau2 harness a backlog that grew to MINUTES — and
   * that harness discards buffered audio on barge-in, so 36% of all agent speech
   * was destroyed unheard (p99 181s per barge-in, against 15s max on the
   * pipeline transport). Only a timeline running AHEAD of the wall clock is
   * starved by pacing, and it now has to say so.
   */
  describe("audio pacing is client-declared", () => {
    /** Start a host session with the given host block; report the start options. */
    async function startOptsFor(
      host: Record<string, unknown>,
    ): Promise<{ calls: number; audioLeadMs: unknown }> {
      const ws = openMockWs();
      let startSession: ReturnType<typeof vi.fn> = vi.fn();
      startHostSession(asSessionWs(ws), {
        env: { AAI_ALLOW_HOST: "1" },
        logger: silentLogger,
        createRuntime: (o) => {
          const fake = makeFakeRuntime(o);
          startSession = fake.startSession;
          return fake.runtime;
        },
      });
      ws.simulateMessage(
        hostConfigFrame({
          host: { systemPrompt: "You are a host agent.", tools: [TOOL_SCHEMA], ...host },
        }),
      );
      await flush();
      const opts = startSession.mock.calls[0]?.[1] as { audioLeadMs?: unknown } | undefined;
      return { calls: startSession.mock.calls.length, audioLeadMs: opts?.audioLeadMs };
    }

    test("an omitted audioLeadMs leaves the pacer's real-time default in place", async () => {
      // Unset rather than a number: the pacer owns the default lead, so passing
      // one here would fork it.
      const { calls, audioLeadMs } = await startOptsFor({});
      expect(calls).toBe(1);
      expect(audioLeadMs).toBeUndefined();
    });

    test("null opts out of pacing entirely", async () => {
      const { calls, audioLeadMs } = await startOptsFor({ audioLeadMs: null });
      expect(calls).toBe(1);
      expect(audioLeadMs).toBe(UNPACED_AUDIO_LEAD_MS);
    });

    test("a number sets that lead", async () => {
      const { calls, audioLeadMs } = await startOptsFor({ audioLeadMs: 250 });
      expect(calls).toBe(1);
      expect(audioLeadMs).toBe(250);
    });

    // Zero and negatives are rejected by the schema rather than silently
    // becoming "unpaced" — a lead of 0 would hold every frame forever.
    test("a non-positive audioLeadMs is refused at the handshake", async () => {
      const ws = openMockWs();
      const createRuntime = vi.fn();
      startHostSession(asSessionWs(ws), {
        env: { AAI_ALLOW_HOST: "1" },
        logger: silentLogger,
        createRuntime,
      });
      ws.simulateMessage(
        hostConfigFrame({
          host: { systemPrompt: "s", tools: [], audioLeadMs: 0 },
        }),
      );
      await flush();
      expect(createRuntime).not.toHaveBeenCalled();
    });
  });

  /**
   * The host-side counterpart of aai-ui's `assertGranted`. The Voice Agent API
   * accepts 24 kHz alone and honours no declaration otherwise, so audio at any
   * other rate is decoded at 24 kHz and the service then emits NOTHING — no
   * speech edge, no transcript, no error. Measured live, 16 kHz relabelled as
   * 24 kHz produced zero events on 4 of 5 sessions; a tau2 retail run scored
   * 2/25 that way. Pinning the rates makes every NUMBER say 24 kHz and cannot
   * make the BYTES 24 kHz, and nothing later in the session can detect the
   * difference — so a client that declares a rate we cannot honour has to be
   * turned away here rather than silently overridden.
   */
  describe("S2S sample-rate handshake guard", () => {
    const s2sBase = { name: "a", systemPrompt: "s", greeting: "", maxSteps: 5, tools: {} };

    test("rejects a config frame declaring a rate the Voice Agent API cannot honour", async () => {
      const ws = openMockWs();
      const createRuntime = vi.fn();

      startHostSession(asSessionWs(ws), {
        env: { AAI_ALLOW_HOST: "1" },
        baseAgent: { ...s2sBase, s2s: assemblyAIS2s() },
        logger: silentLogger,
        createRuntime,
      });
      ws.simulateMessage(hostConfigFrame()); // declares 8000 / 16000
      await flush();

      expect(createRuntime).not.toHaveBeenCalled();
      const err = ws
        .sentJson()
        .find(
          (e): e is Extract<SessionEvent, { type: "error.reported" }> =>
            e.type === "error.reported",
        );
      expect(err?.code).toBe("protocol");
      // Names both offending fields and what to send instead.
      expect(err?.message).toContain("sampleRate=8000");
      expect(err?.message).toContain("ttsSampleRate=16000");
      expect(err?.message).toContain("24000");
    });

    test("accepts a frame that declares the supported rate", async () => {
      const ws = openMockWs();
      const createRuntime = vi.fn((o: RuntimeOptions) => makeFakeRuntime(o).runtime);

      startHostSession(asSessionWs(ws), {
        env: { AAI_ALLOW_HOST: "1", ASSEMBLYAI_API_KEY: "k" },
        baseAgent: { ...s2sBase, s2s: assemblyAIS2s() },
        logger: silentLogger,
        createRuntime,
      });
      ws.simulateMessage(hostConfigFrame({ sampleRate: 24_000, ttsSampleRate: 24_000 }));
      await flush();

      expect(createRuntime).toHaveBeenCalledTimes(1);
    });

    test("accepts a frame that declares no rates — that means 'tell me what to use'", async () => {
      const ws = openMockWs();
      const createRuntime = vi.fn((o: RuntimeOptions) => makeFakeRuntime(o).runtime);

      startHostSession(asSessionWs(ws), {
        env: { AAI_ALLOW_HOST: "1", ASSEMBLYAI_API_KEY: "k" },
        baseAgent: { ...s2sBase, s2s: assemblyAIS2s() },
        logger: silentLogger,
        createRuntime,
      });
      ws.simulateMessage(
        JSON.stringify({ type: "config", host: { systemPrompt: "s", tools: [] } }),
      );
      await flush();

      expect(createRuntime).toHaveBeenCalledTimes(1);
    });

    test("leaves a pipeline agent's requested rates alone — they are negotiable there", async () => {
      const ws = openMockWs();
      let captured: RuntimeOptions | undefined;

      startHostSession(asSessionWs(ws), {
        env: { AAI_ALLOW_HOST: "1" },
        logger: silentLogger,
        createRuntime: (o) => {
          captured = o;
          return makeFakeRuntime(o).runtime;
        },
      });
      ws.simulateMessage(hostConfigFrame());
      await flush();

      expect(captured?.s2sConfig).toMatchObject({
        inputSampleRate: 8000,
        outputSampleRate: 16_000,
      });
    });
  });

  test("rejects with a protocol error when AAI_ALLOW_HOST is disabled", async () => {
    const ws = openMockWs();
    const createRuntime = vi.fn();

    startHostSession(asSessionWs(ws), {
      env: { AAI_ALLOW_HOST: "0" },
      logger: silentLogger,
      createRuntime,
    });
    ws.simulateMessage(hostConfigFrame());
    await flush(); // the env gate runs after the env resolves

    expect(createRuntime).not.toHaveBeenCalled();
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: "error.reported", code: "protocol" }),
    );
  });

  test("the client's credentials reach the per-connection runtime and beat the server's", async () => {
    // The multi-tenant shape: the server holds only the gate, so the session
    // can only run on a key the caller brought.
    const ws = openMockWs();
    let captured: RuntimeOptions | undefined;

    startHostSession(asSessionWs(ws), {
      env: { AAI_ALLOW_HOST: "1", ASSEMBLYAI_API_KEY: "operator" },
      logger: silentLogger,
      createRuntime: (o) => {
        captured = o;
        return makeFakeRuntime(o).runtime;
      },
    });

    ws.simulateMessage(
      hostConfigFrame({
        host: {
          systemPrompt: "You are a host agent.",
          tools: [],
          credentials: { ASSEMBLYAI_API_KEY: "tenant" },
        },
      }),
    );
    await flush();

    expect(captured?.env).toMatchObject({ ASSEMBLYAI_API_KEY: "tenant" });
  });

  test("a credential name outside the provider allowlist rejects the handshake", async () => {
    const ws = openMockWs();
    const createRuntime = vi.fn();

    startHostSession(asSessionWs(ws), {
      env: { AAI_ALLOW_HOST: "1" },
      logger: silentLogger,
      createRuntime,
    });

    ws.simulateMessage(
      hostConfigFrame({
        host: {
          systemPrompt: "You are a host agent.",
          tools: [],
          credentials: { DATABASE_URL: "postgres://attacker" },
        },
      }),
    );
    await flush();

    // No runtime at all — the rejection lands before anything is built, so
    // the smuggled value never reaches provider or db resolution.
    expect(createRuntime).not.toHaveBeenCalled();
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({
        type: "error.reported",
        code: "protocol",
        message: expect.stringContaining("DATABASE_URL"),
      }),
    );
  });

  test("a handshake landing before a slow env fetch resolves still starts the session", async () => {
    // The platform's agent env is a Vault fetch. Awaiting it BEFORE attaching
    // the message listener lost the client's config frame (ws does not buffer
    // for late listeners); the env now rides along as a promise and the
    // listener attaches synchronously.
    const ws = openMockWs();
    const envGate = Promise.withResolvers<Record<string, string>>();
    let startSession: ReturnType<typeof vi.fn> = vi.fn();

    startHostSession(asSessionWs(ws), {
      env: envGate.promise,
      allowHost: true,
      logger: silentLogger,
      createRuntime: (o) => {
        const fake = makeFakeRuntime(o);
        startSession = fake.startSession;
        return fake.runtime;
      },
    });

    // The frame arrives while the env fetch is still in flight.
    ws.simulateMessage(hostConfigFrame());
    expect(startSession).not.toHaveBeenCalled();

    envGate.resolve({});
    await vi.waitFor(() => {
      expect(startSession).toHaveBeenCalledTimes(1);
    });
  });

  test("a rejected env fetch rejects the handshake instead of hanging the socket", async () => {
    const ws = openMockWs();
    const createRuntime = vi.fn();
    startHostSession(asSessionWs(ws), {
      env: Promise.reject(new Error("vault down")),
      allowHost: true,
      logger: silentLogger,
      createRuntime,
    });
    ws.simulateMessage(hostConfigFrame());

    await vi.waitFor(() => {
      expect(ws.sentJson()).toContainEqual(
        expect.objectContaining({ type: "error.reported", code: "protocol" }),
      );
    });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  test("socket close shuts down the per-connection runtime (releases owned resources)", async () => {
    // The runtime is single-use: without shutdown() every host-mode
    // connect/disconnect strands runtime-owned resources (above all a
    // DATABASE_URL-backed pg pool) in the server process.
    const ws = openMockWs();
    let shutdown: ReturnType<typeof vi.fn> | undefined;
    startHostSession(asSessionWs(ws), {
      env: { AAI_ALLOW_HOST: "1" },
      logger: silentLogger,
      createRuntime: (o) => {
        const fake = makeFakeRuntime(o);
        shutdown = fake.runtime.shutdown as ReturnType<typeof vi.fn>;
        return fake.runtime;
      },
    });
    ws.simulateMessage(hostConfigFrame());
    await flush();
    expect(shutdown).toBeDefined();
    expect(shutdown).not.toHaveBeenCalled();

    ws.close();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  test("a socket that closes before any handshake releases the timer without a rejection log", () => {
    vi.useFakeTimers();
    try {
      const ws = openMockWs();
      const logger = makeLogger();
      startHostSession(asSessionWs(ws), {
        env: { AAI_ALLOW_HOST: "1" },
        logger,
      });
      ws.close();
      vi.runAllTimers();
      // No "handshake rejected" warn for a connection that simply went away.
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects when the first frame is not a valid host config", () => {
    const ws = openMockWs();
    const createRuntime = vi.fn();

    startHostSession(asSessionWs(ws), {
      // Enabled, so the rejection below is attributable to the bad frame.
      env: { AAI_ALLOW_HOST: "1" },
      logger: silentLogger,
      createRuntime,
    });
    ws.simulateMessage(JSON.stringify({ type: "audio_ready" }));

    expect(createRuntime).not.toHaveBeenCalled();
    expect(ws.sentJson()).toContainEqual(
      expect.objectContaining({ type: "error.reported", code: "protocol" }),
    );
  });

  test("a client tool_result unblocks a relayed tool call end-to-end", async () => {
    // Wire a real SessionCore (relay mode) behind the real ws-handler dispatch,
    // proving: onToolCall relays via executeTool (no duplicate emit) and an
    // inbound tool_result frame routes through onToolResult to settle the call.
    // Live model-driven tool calls are exercised in Task A4.
    const ws = new MockWebSocket("ws://test");
    const relay = createRelayExecuteTool({ send: (e) => ws.send(JSON.stringify(e)) });
    const transport = makeFakeTransport();
    const logger = makeLogger();

    let core: ReturnType<typeof createSessionCore> | undefined;
    wireSessionSocket(asSessionWs(ws), {
      sessions: createOwnedMap(),
      logger,
      readyConfig: { audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 },
      createSession: (_sid, client) => {
        core = createSessionCore({
          id: "s1",
          agent: "host",
          client,
          emitter: makeEmitter(client, { sessionId: "s1" }).emitter,
          agentConfig: makeConfig(),
          executeTool: relay.executeTool,
          transport,
          onToolResult: relay.onToolResult,
          logger: silentLogger,
        });
        return core;
      },
    });

    await vi.waitFor(() => {
      expect(logger.info.mock.calls.map((c) => c[0])).toContain("Session ready");
    });
    if (!core) throw new Error("session core was not created");

    // Drive a tool call as an S2S transport would.
    core.onReplyStarted("r1");
    core.report({ type: "tool.called", toolCallId: "call-1", toolName: "lookup", args: { q: 1 } });

    const toolCalls = ws.sentJson().filter((m) => m.type === "tool.called");
    expect(toolCalls).toEqual([
      { type: "tool.called", toolCallId: "call-1", toolName: "lookup", args: { q: 1 } },
    ]);

    // Client answers over the wire; dispatch → onToolResult → relay resolves.
    ws.simulateMessage(
      JSON.stringify({ type: "tool_result", toolCallId: "call-1", result: "sunny" }),
    );

    await vi.waitFor(() => {
      expect(ws.sentJson()).toContainEqual(
        expect.objectContaining({ type: "tool.completed", toolCallId: "call-1", result: "sunny" }),
      );
    });
  });
});
