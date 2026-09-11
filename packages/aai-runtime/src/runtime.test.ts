// Copyright 2025 the AAI authors. MIT license.
// Runtime config mapping and tool execution: toAgentConfig, createRuntime
// tool plumbing (including sandbox mode), and executeToolCall. Session
// lifecycle/routing specs live in runtime-lifecycle.test.ts.

import type { ToolDef } from "@alexkroman1/aai";
import { sessionSlot } from "@alexkroman1/aai";
import {
  ASSEMBLYAI_S2S_SAMPLE_RATE,
  DEFAULT_VOICE_FOCUS,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
} from "@alexkroman1/aai/host-internal";
import {
  DEFAULT_BUILTIN_TOOLS,
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_TURN_SILENCE_MS,
} from "@alexkroman1/aai/internal";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL, anthropicLlm } from "@alexkroman1/aai/llm";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { assemblyAIS2s } from "@alexkroman1/aai/s2s";
import { assemblyAIStt } from "@alexkroman1/aai/stt";
import { ASSEMBLYAI_TTS_DEFAULT_VOICE, cartesiaTts } from "@alexkroman1/aai/tts";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { CONFORMANCE_AGENT, testRuntime } from "./_runtime-conformance.ts";
import { makeAgent, makeLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import { executeToolCall } from "./tool-executor.ts";

describe("toAgentConfig", () => {
  test("maps name, systemPrompt, greeting from AgentDef", () => {
    const config = toAgentConfig(makeAgent());
    expect(config.name).toBe("test-agent");
    expect(config.systemPrompt).toBe("Be helpful.");
    expect(config.greeting).toBe("Hello!");
  });

  test("includes sttPrompt when defined", () => {
    const config = toAgentConfig(makeAgent({ sttPrompt: "transcription hint" }));
    expect(config.sttPrompt).toBe("transcription hint");
  });

  test("omits sttPrompt when undefined", () => {
    const config = toAgentConfig(makeAgent());
    expect(config).not.toHaveProperty("sttPrompt");
  });

  test("includes static maxSteps", () => {
    const config = toAgentConfig(makeAgent({ maxSteps: 10 }));
    expect(config.maxSteps).toBe(10);
  });

  test("includes toolChoice when defined", () => {
    const config = toAgentConfig(makeAgent({ toolChoice: "required" }));
    expect(config.toolChoice).toBe("required");
  });

  test("omits toolChoice when undefined", () => {
    const config = toAgentConfig(makeAgent());
    expect(config).not.toHaveProperty("toolChoice");
  });

  test("includes builtinTools when defined", () => {
    const config = toAgentConfig(makeAgent({ builtinTools: ["web_search", "run_code"] }));
    expect(config.builtinTools).toEqual(["web_search", "run_code"]);
  });
});

describe("createRuntime", () => {
  test("executeTool returns error for unknown tool", async () => {
    const exec = createRuntime({ agent: makeAgent(), env: {} });
    const result = await exec.executeTool("nonexistent", {}, "session-1", []);
    expect(result).toBe(JSON.stringify({ error: "Unknown tool: nonexistent" }));
  });

  test("executeTool with a real tool returns result", async () => {
    const agent = makeAgent({
      tools: {
        add: {
          description: "Add two numbers",
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }: { a: number; b: number }) => String(a + b),
        },
      },
    });
    const exec = createRuntime({ agent, env: {} });
    expect(await exec.executeTool("add", { a: 3, b: 4 }, "s1", [])).toBe("7");
  });

  // An "executeTool passes db to tool context" test stood here, running a tool
  // that read rows through `ctx.db`. Gone with the field — the platform
  // provisions no database and hands tool code none.

  // providerEnv exists so a self-hosted caller can feed shell-exported
  // credentials to the provider resolvers without agent code being able to
  // read them — and without breaking dev/prod parity for ctx.env.
  test("ctx.env exposes env only, never providerEnv", async () => {
    const agent = makeAgent({
      tools: {
        dump_env: {
          description: "Return the env keys visible to tool code",
          execute: (_args, ctx) => Object.keys(ctx.env).sort().join(","),
        },
      },
    });
    const exec = createRuntime({
      agent,
      env: { APP_SETTING: "visible" },
      providerEnv: { APP_SETTING: "visible", ANTHROPIC_API_KEY: "shell-only" },
    });
    expect(await exec.executeTool("dump_env", {}, "s1", [])).toBe("APP_SETTING");
  });

  test("ctx.env falls back to env when providerEnv is omitted", async () => {
    const agent = makeAgent({
      tools: {
        dump_env: {
          description: "Return the env keys visible to tool code",
          execute: (_args, ctx) => Object.keys(ctx.env).sort().join(","),
        },
      },
    });
    const exec = createRuntime({ agent, env: { APP_SETTING: "visible" } });
    expect(await exec.executeTool("dump_env", {}, "s1", [])).toBe("APP_SETTING");
  });

  test("toolSchemas includes both custom and builtin tools", () => {
    const agent = makeAgent({
      builtinTools: ["run_code"],
      tools: {
        custom: { description: "Custom", execute: () => "ok" },
      },
    });
    const exec = createRuntime({ agent, env: {} });
    const names = exec.toolSchemas.map((s) => s.name);
    expect(names).toContain("custom");
    expect(names).toContain("run_code");
  });

  test("a slot installs its default on first read", async () => {
    const slot = sessionSlot("counter", () => ({ counter: 0 }));
    const agent = makeAgent({
      tools: {
        get_state: {
          description: "Get state",
          execute: (_args, ctx) => JSON.stringify(slot.get(ctx)),
        },
      },
    });
    const exec = createRuntime({ agent, env: {} });
    const result = await exec.executeTool("get_state", {}, "s1", []);
    expect(JSON.parse(result)).toEqual({ counter: 0 });
  });

  // The regression this replaced: `getState`'s `?? {}` minted a fresh object per
  // read, so the write below landed and vanished — silently, and for four of the
  // five shipped slot-backed templates.
  test("slot state persists across tool calls", async () => {
    const slot = sessionSlot("bumped", () => ({ n: 0 }));
    const agent = makeAgent({
      tools: {
        bump: {
          description: "Bump a counter in the slot",
          execute: (_args, ctx) =>
            String(
              slot.update(ctx, (state) => {
                state.n += 1;
                return state.n;
              }),
            ),
        },
      },
    });
    const exec = createRuntime({ agent, env: {} });
    expect(await exec.executeTool("bump", {}, "s1", [])).toBe("1");
    expect(await exec.executeTool("bump", {}, "s1", [])).toBe("2");
    // A different session must not inherit it.
    expect(await exec.executeTool("bump", {}, "s2", [])).toBe("1");
  });

  test("executeTool passes messages to tool context", async () => {
    const agent = makeAgent({
      tools: {
        echo_messages: {
          description: "Echo messages",
          execute: (_args, ctx) => JSON.stringify(ctx.messages),
        },
      },
    });
    const exec = createRuntime({ agent, env: {} });
    const msgs = [{ role: "user" as const, content: "hi" }];
    const result = await exec.executeTool("echo_messages", {}, "s1", msgs);
    expect(JSON.parse(result)).toEqual(msgs);
  });

  test("sandbox mode forwards callOpts (toolCallId) to the RPC executor", async () => {
    // Regression: the RPC wrapper previously dropped the 5th `callOpts` arg, so
    // relayed tool calls reached the client without a toolCallId and failed with
    // "invoked without a toolCallId" in pipeline mode.
    const rpcExecuteTool = vi.fn(async () => "ok");
    const exec = createRuntime({
      agent: makeAgent({ tools: {} }),
      env: {},
      executeTool: rpcExecuteTool,
      toolSchemas: [
        {
          type: "function" as const,
          name: "find_user",
          description: "Find a user",
          parameters: { type: "object" },
        },
      ],
    });

    const result = await exec.executeTool("find_user", {}, "s1", [], { toolCallId: "toolu_123" });

    expect(result).toBe("ok");
    expect(rpcExecuteTool).toHaveBeenCalledWith("find_user", {}, "s1", [], {
      toolCallId: "toolu_123",
    });
  });

  test("env is frozen and passed to tools", async () => {
    const agent = makeAgent({
      tools: {
        get_env: {
          description: "Get env",
          execute: (_args, ctx) => ctx.env.MY_VAR ?? "missing",
        },
      },
    });
    const exec = createRuntime({ agent, env: { MY_VAR: "hello" } });
    const result = await exec.executeTool("get_env", {}, "s1", []);
    expect(result).toBe("hello");
  });

  test("readyConfig is present with audio format", () => {
    const exec = createRuntime({ agent: makeAgent(), env: {} });
    expect(exec.readyConfig).toEqual(
      expect.objectContaining({ audioFormat: "pcm16", sampleRate: expect.any(Number) }),
    );
  });

  /**
   * The Voice Agent API accepts 24 kHz alone, so the ready frame — which is
   * what tells a client what to capture and play — must name that rate and not
   * whatever was requested. A host-mode client that DECLARED something else was
   * already refused at the handshake (`assertHostRatesSupported`), so the only
   * caller that reaches this override is an operator passing `s2sConfig`
   * directly, who gets the warn.
   */
  test("readyConfig pins an AssemblyAI S2S session to the service's only rate", () => {
    const exec = createRuntime({
      agent: makeAgent({ s2s: assemblyAIS2s() }),
      env: { ASSEMBLYAI_API_KEY: "k" },
      s2sConfig: {
        wssUrl: "wss://fake",
        inputSampleRate: 16_000,
        outputSampleRate: 16_000,
      },
    });
    expect(exec.readyConfig).toEqual({
      audioFormat: "pcm16",
      sampleRate: ASSEMBLYAI_S2S_SAMPLE_RATE,
      ttsSampleRate: ASSEMBLYAI_S2S_SAMPLE_RATE,
    });
  });

  test("a pipeline agent's rates are left entirely alone", () => {
    const exec = createRuntime({
      agent: makeAgent({
        stt: assemblyAIStt(),
        llm: anthropicLlm({ model: "claude-sonnet-5" }),
        tts: cartesiaTts({ voice: "v" }),
      }),
      env: {
        ASSEMBLYAI_API_KEY: "k",
        ANTHROPIC_API_KEY: "k",
        CARTESIA_API_KEY: "k",
      },
      s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 16_000 },
    });
    expect(exec.readyConfig).toMatchObject({ sampleRate: 16_000, ttsSampleRate: 16_000 });
  });

  test("shutdown resolves immediately when no sessions exist", async () => {
    const exec = createRuntime({ agent: makeAgent(), env: {} });
    await expect(exec.shutdown()).resolves.toBeUndefined();
  });

  // A `typeof exec.startSession === "function"` case lived here; what it
  // FORWARDS is asserted over a real socket in `runtime-lifecycle.test.ts`,
  // which this file's header already defers session lifecycle to.
});

/**
 * A tool whose `execute` resolves to something other than the declared
 * `string`, for the coercion paths below. Agent bundles are not typechecked by
 * either bundler, so these values really do reach `executeToolCall` in
 * production — the cast stages that, and stays at this one seam; the
 * escape-hatch ratchet counts every occurrence.
 */
function toolReturning(description: string, value: unknown): ToolDef {
  return { description, execute: () => value as unknown as string };
}

describe("executeToolCall", () => {
  test("returns 'null' when tool execute returns null", async () => {
    const tool = toolReturning("Returns null", null);
    const result = await executeToolCall("nullTool", {}, { tool, env: {} });
    expect(result).toBe("null");
  });

  test("returns 'null' when tool execute returns undefined", async () => {
    const tool = toolReturning("Returns undefined", undefined);
    const result = await executeToolCall("undefinedTool", {}, { tool, env: {} });
    expect(result).toBe("null");
  });

  test("JSON.stringifies non-string results", async () => {
    const tool = toolReturning("Returns object", { count: 42 });
    const result = await executeToolCall("objTool", {}, { tool, env: {} });
    expect(result).toBe(JSON.stringify({ count: 42 }));
  });

  test("JSON.stringifies numeric results", async () => {
    const tool = toolReturning("Returns number", 123);
    const result = await executeToolCall("numTool", {}, { tool, env: {} });
    expect(result).toBe("123");
  });

  test("returns validation error for invalid args", async () => {
    const tool: ToolDef = {
      description: "Requires number",
      inputSchema: z.object({ n: z.number() }),
      execute: ({ n }: { n: number }) => String(n),
    };
    const result = await executeToolCall("typedTool", { n: "not-a-number" }, { tool, env: {} });
    expect(result).toContain("error");
    expect(result).toContain("Invalid arguments");
    expect(result).toContain("typedTool");
  });

  test("returns validation error with path info for nested args", async () => {
    const tool: ToolDef = {
      description: "Requires nested object",
      inputSchema: z.object({ config: z.object({ port: z.number() }) }),
      execute: () => "ok",
    };
    const result = await executeToolCall(
      "nestedTool",
      { config: { port: "abc" } },
      { tool, env: {} },
    );
    expect(result).toContain("config.port");
  });

  test("logs error with logger when tool throws", async () => {
    const tool: ToolDef = {
      description: "Throws error",
      execute: () => {
        throw new Error("boom");
      },
    };
    const logger = makeLogger();
    const result = await executeToolCall("failTool", {}, { tool, env: {}, logger });
    expect(result).toContain("error");
    expect(result).toContain("boom");
    expect(logger.warn).toHaveBeenCalledWith(
      "Tool execution failed",
      expect.objectContaining({ tool: "failTool" }),
    );
  });

  test("logs to console.warn when no logger provided", async () => {
    const tool: ToolDef = {
      description: "Throws error",
      execute: () => {
        throw new Error("no-logger-boom");
      },
    };
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await executeToolCall("failTool", {}, { tool, env: {} });
    expect(result).toContain("error");
    expect(result).toContain("no-logger-boom");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[tool-executor] Tool execution failed: failTool"),
      expect.any(Error),
    );
  });

  // A "throws the no-database guidance when db is not provided" test stood here.
  // `ctx.db` is gone, so there is no guidance to throw: a tool reaching for it
  // now gets a `TypeError`, which `tool-executor.test.ts` pins as the contract.

  test("a sessionless call gets its own detached slot store", async () => {
    // Detached rather than shared: two such calls must not read each other's
    // slots — the same rule the per-call `sessionId` encodes for the note builtins.
    const slot = sessionSlot("scratch", () => ({ n: 0 }));
    const tool: ToolDef = {
      description: "Bump and report",
      execute: (_args, ctx) => JSON.stringify(slot.update(ctx, (s) => ++s.n)),
    };
    const first = await executeToolCall("stateTool", {}, { tool, env: {} });
    const second = await executeToolCall("stateTool", {}, { tool, env: {} });
    expect([JSON.parse(first), JSON.parse(second)]).toEqual([1, 1]);
  });

  test("uses default empty messages when messages not provided", async () => {
    const tool: ToolDef = {
      description: "Get messages",
      execute: (_args, ctx) => JSON.stringify(ctx.messages),
    };
    const result = await executeToolCall("msgTool", {}, { tool, env: {} });
    expect(JSON.parse(result)).toEqual([]);
  });

  test("mints a unique sessionId when not provided", async () => {
    // Not "": the builtin remember/recall notes are keyed by sessionId in a
    // process-wide map, so sessionless callers sharing the "" bucket would
    // read each other's notes.
    const tool: ToolDef = {
      description: "Get sessionId",
      execute: (_args, ctx) => ctx.sessionId,
    };
    const first = await executeToolCall("sidTool", {}, { tool, env: {} });
    const second = await executeToolCall("sidTool", {}, { tool, env: {} });
    expect(first).not.toBe("");
    expect(second).not.toBe(first);
  });

  test("tool with no parameters schema accepts any args", async () => {
    const tool: Parameters<typeof executeToolCall>[2]["tool"] = {
      description: "No params",
      execute: () => "ok",
    };
    const result = await executeToolCall("noParamsTool", { any: "thing" }, { tool, env: {} });
    expect(result).toBe("ok");
  });
});

describe("createRuntime sandbox mode", () => {
  test("uses provided executeTool and adds no builtins by default", async () => {
    const mockExecuteTool = vi.fn(async () => "mocked-result");
    const mockToolSchemas = [
      { type: "function" as const, name: "mock_tool", description: "A mock tool", parameters: {} },
    ];

    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      executeTool: mockExecuteTool,
      toolSchemas: mockToolSchemas,
    });

    // Relay/host-mode path. DEFAULT_BUILTIN_TOOLS is empty, so an agent that
    // sets no `builtinTools` gets exactly the tools it declared — nothing is
    // appended behind its back.
    expect(runtime.toolSchemas.map((s) => s.name)).toEqual(["mock_tool"]);
    const result = await runtime.executeTool("any_tool", {}, "s1", []);
    expect(result).toBe("mocked-result");
    // The wrapper forwards a 5th `callOpts` arg (undefined when omitted).
    expect(mockExecuteTool).toHaveBeenCalledWith("any_tool", {}, "s1", [], undefined);
  });

  test("an ENABLED builtin executes host-side, not via the relay", async () => {
    // Builtins are opt-in now, but the routing they rely on is unchanged: a
    // builtin runs in this process rather than being relayed to the client,
    // which has no implementation for it.
    const mockExecuteTool = vi.fn(async () => "relayed");
    const runtime = createRuntime({
      agent: makeAgent({ builtinTools: ["calculate"] }),
      env: {},
      executeTool: mockExecuteTool,
      toolSchemas: [],
    });

    const result = await runtime.executeTool("calculate", { expression: "2 + 2" }, "s1", []);
    expect(result).toContain("4");
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  test("a relayed tool with a builtin's name wins — the builtin is dropped", async () => {
    const mockExecuteTool = vi.fn(async () => "relayed");
    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      executeTool: mockExecuteTool,
      toolSchemas: [
        {
          type: "function" as const,
          name: "calculate",
          description: "Client calculate",
          parameters: {},
        },
      ],
    });

    expect(runtime.toolSchemas.filter((s) => s.name === "calculate")).toHaveLength(1);
    expect(runtime.toolSchemas[0]?.description).toBe("Client calculate");
    const result = await runtime.executeTool("calculate", { expression: "1 + 1" }, "s1", []);
    expect(result).toBe("relayed");
    expect(mockExecuteTool).toHaveBeenCalledOnce();
  });

  test("explicit builtinTools: [] disables the defaults", () => {
    const mockToolSchemas = [
      { type: "function" as const, name: "mock_tool", description: "A mock tool", parameters: {} },
    ];
    const runtime = createRuntime({
      agent: makeAgent({ builtinTools: [] }),
      env: {},
      executeTool: vi.fn(async () => "ok"),
      toolSchemas: mockToolSchemas,
    });
    expect(runtime.toolSchemas.map((s) => s.name)).toEqual(["mock_tool"]);
  });

  test("sandbox path gets the default builtins merged alongside the agent's tools", () => {
    // Regression guard: the platform used to resolve builtins itself off
    // `IsolateConfig.builtinTools ?? []` and pass them in pre-resolved. Since
    // the deploy path builds its config with `toAgentConfig` (which does not
    // default `builtinTools`), every
    // deployed agent that didn't set `builtinTools` silently lost the default
    // cognitive builtins. Resolution now lives here for every caller.
    const mockToolSchemas = [
      { type: "function" as const, name: "mock_tool", description: "A mock tool", parameters: {} },
    ];
    const runtime = createRuntime({
      agent: makeAgent(),
      env: {},
      executeTool: vi.fn(async () => "ok"),
      toolSchemas: mockToolSchemas,
    });
    const names = runtime.toolSchemas.map((s) => s.name);
    expect(names).toContain("mock_tool");
    expect(names).toEqual(expect.arrayContaining([...DEFAULT_BUILTIN_TOOLS]));
  });
});

// ── Shared conformance suite (same tests run against sandbox in integration) ─

const directExec = createRuntime({
  agent: CONFORMANCE_AGENT,
  // ASSEMBLYAI_API_KEY: a provider-less agent now defaults to the AssemblyAI
  // pipeline, whose LLM resolves (and requires its key) at runtime creation.
  env: { MY_VAR: "test-value", ASSEMBLYAI_API_KEY: "test" },
});

testRuntime("direct", () => ({
  executeTool: directExec.executeTool,
}));

describe("createRuntime — provider resolution seams", () => {
  // Providers resolve eagerly, so the runtime needs keys to construct at all.
  const PROVIDER_KEYS = {
    ASSEMBLYAI_API_KEY: "k",
    ANTHROPIC_API_KEY: "k",
    CARTESIA_API_KEY: "k",
  };
  const baseAgent = {
    name: "Notes",
    systemPrompt: "x",
    greeting: "",
    maxSteps: 1,
    tools: {},
  };

  test.each([
    ["deadAirCoverMs", { deadAirCoverMs: 2500 }],
    ["minBargeInWords", { minBargeInWords: 3 }],
    ["interruptionMinDurationMs", { interruptionMinDurationMs: 200 }],
    ["resumeFalseInterruption", { resumeFalseInterruption: false }],
  ])("accepts %s when the providers arrive as runtime options", (_name, tuning) => {
    // The platform strips stt/llm/tts off
    // the agent object and passes them as options, so validating the agent's
    // own fields resolved mode "s2s" and rejected every pipeline tuning knob —
    // a deployed pipeline agent with a tuning knob (`holdPhrase`, at the time)
    // failed at session start with "holdPhrase requires pipeline mode (stt,
    // llm, and tts all set)" while
    // `aai dev`, which does hand over the descriptors, worked fine.
    expect(() =>
      createRuntime({
        agent: { ...baseAgent, ...tuning },
        env: PROVIDER_KEYS,
        stt: assemblyAIStt({ model: "universal-3-5-pro" }),
        llm: anthropicLlm({ model: "claude-haiku-4-5" }),
        tts: cartesiaTts(),
      }),
    ).not.toThrow();
  });

  test("logs the resolved session mode and provider kinds", () => {
    // A pipeline agent whose providers don't reach the runtime runs a healthy
    // S2S session instead, so the mode must be readable from one log line
    // rather than inferred from the shape of the message stream.
    const logger = makeLogger();
    createRuntime({
      agent: baseAgent,
      env: PROVIDER_KEYS,
      logger,
      stt: assemblyAIStt({ model: "universal-3-5-pro" }),
      llm: anthropicLlm({ model: "claude-haiku-4-5" }),
      tts: cartesiaTts(),
    });
    expect(logger.info).toHaveBeenCalledWith(
      "Session mode resolved",
      expect.objectContaining({
        mode: "pipeline",
        stt: expect.objectContaining({ kind: "assemblyai" }),
        llm: expect.objectContaining({ kind: "anthropic", model: "claude-haiku-4-5" }),
        tts: expect.objectContaining({ kind: "cartesia" }),
      }),
    );
  });

  test("logs pipeline mode for an agent that declares no providers (the default)", () => {
    const logger = makeLogger();
    createRuntime({ agent: baseAgent, env: PROVIDER_KEYS, logger });
    expect(logger.info).toHaveBeenCalledWith(
      "Session mode resolved",
      expect.objectContaining({
        mode: "pipeline",
        stt: expect.objectContaining({ kind: "assemblyai" }),
        llm: expect.objectContaining({ kind: "assemblyai" }),
      }),
    );
  });

  // The kind alone was the whole log for a long time, and it is the least
  // useful half: every value that decides how a session behaves is a DEFAULT
  // nobody wrote down, so a split utterance or a mute agent could not be tied
  // to a setting without re-deriving the `??` chains by hand.
  test("logs each stage's effective settings, defaults included", () => {
    const logger = makeLogger();
    createRuntime({ agent: baseAgent, env: PROVIDER_KEYS, logger });
    const settings = vi
      .mocked(logger.info)
      .mock.calls.find(([msg]) => msg === "Session mode resolved")?.[1] as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(settings?.stt).toMatchObject({
      model: "universal-3-5-pro",
      minTurnSilenceMs: DEFAULT_MIN_TURN_SILENCE_MS,
      maxTurnSilenceMs: DEFAULT_MAX_TURN_SILENCE_MS,
      voiceFocus: DEFAULT_VOICE_FOCUS,
      voiceFocusThreshold: DEFAULT_VOICE_FOCUS_THRESHOLD,
    });
    // The real constants, not `expect.any(String)`: a settings log that can
    // drift from the wire is worse than no log, because it is believed — and
    // `any(String)` is satisfied by whatever the log happens to say.
    expect(settings?.llm).toMatchObject({ model: ASSEMBLYAI_LLM_DEFAULT_MODEL });
    expect(settings?.tts).toMatchObject({ voice: ASSEMBLYAI_TTS_DEFAULT_VOICE });
  });

  test("logs s2s mode for an agent that opts in via the s2s descriptor", () => {
    const logger = makeLogger();
    createRuntime({ agent: { ...baseAgent, s2s: assemblyAIS2s() }, env: PROVIDER_KEYS, logger });
    expect(logger.info).toHaveBeenCalledWith(
      "Session mode resolved",
      expect.objectContaining({ mode: "s2s" }),
    );
  });

  test("still rejects pipeline tuning on a genuine S2S agent", () => {
    // The assertion must keep firing where it is right: an explicit S2S agent.
    expect(() =>
      createRuntime({
        agent: { ...baseAgent, s2s: assemblyAIS2s(), deadAirCoverMs: 2500 },
        env: PROVIDER_KEYS,
      }),
    ).toThrow(/deadAirCoverMs requires pipeline mode/);
  });
});
