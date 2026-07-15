// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent runtime — the execution engine for voice agents.
 *
 * {@link createRuntime} builds the single execution engine used by both
 * self-hosted servers and the platform sandbox. It wires up tool execution,
 * lifecycle hooks, and session management.
 */

import type { LanguageModel } from "ai";
import pTimeout from "p-timeout";
import { createStorage } from "unstorage";
import { agentToolsToSchemas, type ToolSchema, toAgentConfig } from "../sdk/_internal-types.ts";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import { buildReadyConfig, type ReadyConfig } from "../sdk/protocol.ts";
import { OPENAI_API_KEY_ENV } from "../sdk/providers/llm/openai.ts";
import {
  OPENAI_REALTIME_KIND,
  type OpenaiRealtimeOptions,
} from "../sdk/providers/s2s/openai-realtime.ts";
import {
  assertProviderTriple,
  type LlmProvider,
  type SessionMode,
  type SttOpener,
  type SttProvider,
  type TtsOpener,
  type TtsProvider,
} from "../sdk/providers.ts";
import { buildSystemPrompt } from "../sdk/system-prompt.ts";
import type { AgentDef } from "../sdk/types.ts";
import { toolError } from "../sdk/utils.ts";
import type { Vector } from "../sdk/vector.ts";
import { resolveAllBuiltins } from "./builtin-tools.ts";
import { createMemoryVector } from "./memory-vector.ts";
import {
  descriptorKind,
  resolveApiKey,
  resolveLlmIfDescriptor,
  resolveSttApiKey,
  resolveSttIfDescriptor,
  resolveTtsApiKey,
  resolveTtsIfDescriptor,
} from "./providers/resolve.ts";
import { resolveKv } from "./providers/resolve-kv.ts";
import { resolveVector } from "./providers/resolve-vector.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime-config.ts";
import type { Runtime, RuntimeOptions, SessionStartOptions } from "./runtime-types.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";
import { type ExecuteTool, executeToolCall } from "./tool-executor.ts";
import {
  createOpenaiRealtimeTransport,
  type OpenaiRealtimeToolSchema,
} from "./transports/openai-realtime-transport.ts";
import { createPipelineTransport } from "./transports/pipeline-transport.ts";
import { createS2sTransport } from "./transports/s2s-transport.ts";
import type { Transport, TransportCallbacks } from "./transports/types.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws-handler.ts";

export type {
  AgentRuntime,
  Runtime,
  RuntimeOptions,
  SessionStartOptions,
} from "./runtime-types.ts";

// ─── Runtime implementation ──────────────────────────────────────────────────

/**
 * Determine the effective STT/LLM/TTS providers and session mode. Providers
 * come from RuntimeOptions (platform path) or fall back to the agent's own
 * fields (the `aai dev` path passes no provider opts), so a declared pipeline
 * agent isn't silently downgraded to S2S.
 */
function resolveEffectiveProviders(
  opts: RuntimeOptions,
  agent: AgentDef,
): {
  stt: SttProvider | SttOpener | undefined;
  llm: LlmProvider | LanguageModel | undefined;
  tts: TtsProvider | TtsOpener | undefined;
  mode: SessionMode;
} {
  const stt = opts.stt ?? agent.stt;
  const llm = opts.llm ?? agent.llm;
  const tts = opts.tts ?? agent.tts;
  return { stt, llm, tts, mode: assertProviderTriple(stt, llm, tts) };
}

/**
 * Resolve the three pipeline provider instances once per runtime (reused
 * across sessions). Returns null unless the mode is pipeline and all three
 * providers are present.
 */
function resolvePipelineProviders(
  p: {
    mode: SessionMode;
    stt: SttProvider | SttOpener | undefined;
    llm: LlmProvider | LanguageModel | undefined;
    tts: TtsProvider | TtsOpener | undefined;
  },
  env: Record<string, string>,
): { stt: SttOpener; llm: LanguageModel; tts: TtsOpener } | null {
  if (p.mode !== "pipeline" || !(p.stt && p.llm && p.tts)) return null;
  return {
    stt: resolveSttIfDescriptor(p.stt),
    llm: resolveLlmIfDescriptor(p.llm, env),
    tts: resolveTtsIfDescriptor(p.tts),
  };
}

/** Create an in-memory KV store (default for self-hosted). */
function createLocalKv(): Kv {
  return createUnstorageKv({ storage: createStorage() });
}

/** Create an in-memory Vector store (default for self-hosted). */
function createLocalVector(slug: string): Vector {
  return createMemoryVector({ namespace: slug });
}

/**
 * Create an agent runtime — the execution engine for a voice agent.
 *
 * Merges built-in and custom tool definitions, builds tool schemas for the
 * S2S API, and wires up lifecycle hooks.
 *
 * @param opts - Runtime configuration. See {@link RuntimeOptions}.
 * @returns A {@link Runtime} with tool execution, hook invocation,
 *   schemas, and session management.
 *
 * @public
 */
export function createRuntime(opts: RuntimeOptions): Runtime {
  const {
    agent,
    env,
    kv = createLocalKv(),
    vector,
    createWebSocket,
    createOpenaiRealtimeWebSocket,
    logger = consoleLogger,
    s2sConfig = DEFAULT_S2S_CONFIG,
    sessionStartTimeoutMs,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  } = opts;
  // Providers may come from RuntimeOptions (platform path passes them
  // explicitly) or from the agent's own `stt`/`llm`/`tts` fields (the `aai
  // dev` path calls createRuntime({ agent, env }) with no provider opts).
  const {
    stt: sttProvider,
    llm: llmProvider,
    tts: ttsProvider,
    mode,
  } = resolveEffectiveProviders(opts, agent);

  // Resolve descriptors from manifest if present; otherwise use the
  // supplied (or default) instances.
  const slug = agent.name ?? "local";
  const resolvedKv = agent.kv ? resolveKv(agent.kv, env, "") : kv;
  const resolvedVector = agent.vector
    ? resolveVector(agent.vector, env, slug)
    : (vector ?? createLocalVector(slug));

  const agentConfig = toAgentConfig(agent);
  const sessions = new Map<string, SessionCore>();
  const sinkMap = new Map<string, ClientSink>();
  const readyConfig: ReadyConfig = buildReadyConfig(s2sConfig);

  // When overrides are provided (sandbox mode), skip in-process tool setup
  let executeTool: ExecuteTool;
  let toolSchemas: ToolSchema[];
  let toolGuidance: string[] = [];
  // Per-session tool state (self-hosted mode only); cleaned up on session end.
  const stateMap = new Map<string, Record<string, unknown>>();

  const builtinFetchOpt = opts.fetch ? { fetch: opts.fetch } : undefined;

  if (opts.executeTool && opts.toolSchemas) {
    // Sandbox mode — custom tools are RPC-backed; builtins run host-side
    const builtinDefs =
      opts.builtinDefs ?? resolveAllBuiltins(agent.builtinTools ?? [], builtinFetchOpt).defs;
    const rpcExecuteTool = opts.executeTool;
    const frozenEnv = Object.freeze({ ...env });

    executeTool = async (name, args, sessionId, messages) => {
      // Handle builtins on the host (where SSRF-safe fetch lives) — EXCEPT
      // run_code, which executes untrusted JS and must run inside the guest
      // sandbox (gVisor/Deno), never on the host. It is delegated via RPC
      // like a custom tool; the guest harness runs it directly.
      if (name !== "run_code" && builtinDefs[name]) {
        const tool = builtinDefs[name];
        return executeToolCall(name, args, {
          tool,
          env: frozenEnv,
          sessionId: sessionId ?? "",
          kv: resolvedKv,
          vector: resolvedVector,
          messages,
          logger,
        });
      }
      // Delegate custom tools (and run_code) to the isolate via RPC
      return rpcExecuteTool(name, args, sessionId, messages);
    };

    toolSchemas = opts.toolSchemas;
    toolGuidance = opts.toolGuidance ?? [];
  } else {
    // Self-hosted mode — in-process tool execution
    const builtins = resolveAllBuiltins(agent.builtinTools ?? [], builtinFetchOpt);
    const allTools: Record<string, AgentDef["tools"][string]> = {
      ...builtins.defs,
      ...agent.tools,
    };
    const customSchemas = agentToolsToSchemas(agent.tools ?? {});
    toolSchemas = [...customSchemas, ...builtins.schemas];
    toolGuidance = builtins.guidance;

    const getState = (sid: string) => {
      if (!stateMap.has(sid) && agent.state) stateMap.set(sid, agent.state());
      return stateMap.get(sid) ?? {};
    };
    const frozenEnv = Object.freeze({ ...env });

    executeTool = async (name, args, sessionId, messages) => {
      const tool = allTools[name];
      if (!tool) return toolError(`Unknown tool: ${name}`);
      const sink = sinkMap.get(sessionId ?? "");
      return executeToolCall(name, args, {
        tool,
        env: frozenEnv,
        state: getState(sessionId ?? ""),
        sessionId: sessionId ?? "",
        kv: resolvedKv,
        vector: resolvedVector,
        messages,
        logger,
        send: sink ? (event, data) => sink.event({ type: "custom_event", event, data }) : undefined,
      });
    };
  }

  // Resolve pipeline providers once per runtime (not per session). Each
  // session reuses the same opener / LanguageModel — the opener's `open()`
  // mints the per-session stream inside.
  const pipelineProviders = resolvePipelineProviders(
    { mode, stt: sttProvider, llm: llmProvider, tts: ttsProvider },
    env,
  );

  type SessionOpts = {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
  };

  function buildPipelineTransport(args: {
    sessionOpts: SessionOpts;
    systemPrompt: string;
    callbacks: TransportCallbacks;
    providers: { stt: SttOpener; llm: LanguageModel; tts: TtsOpener };
  }): Transport {
    const { sessionOpts, systemPrompt, callbacks, providers } = args;
    return createPipelineTransport({
      sid: sessionOpts.id,
      agent: sessionOpts.agent,
      stt: providers.stt,
      llm: providers.llm,
      tts: providers.tts,
      callbacks,
      sessionConfig: {
        systemPrompt,
        greeting: agentConfig.greeting,
      },
      toolSchemas,
      executeTool,
      providerKeys: {
        stt: resolveSttApiKey(sttProvider, env),
        tts: resolveTtsApiKey(ttsProvider, env),
      },
      sttSampleRate: s2sConfig.inputSampleRate,
      ttsSampleRate: s2sConfig.outputSampleRate,
      maxSteps: agentConfig.maxSteps,
      toolChoice: agentConfig.toolChoice,
      ...(agentConfig.sttPrompt !== undefined ? { sttPrompt: agentConfig.sttPrompt } : {}),
      skipGreeting: sessionOpts.skipGreeting ?? false,
      logger,
    });
  }

  function buildOpenaiRealtimeTransport(args: {
    sessionOpts: SessionOpts;
    systemPrompt: string;
    callbacks: TransportCallbacks;
  }): Transport {
    const { sessionOpts, systemPrompt, callbacks } = args;
    return createOpenaiRealtimeTransport({
      apiKey: resolveApiKey(OPENAI_API_KEY_ENV, env),
      options: (agent.s2s?.options ?? {}) as OpenaiRealtimeOptions,
      sessionConfig: {
        systemPrompt,
        ...(agentConfig.greeting !== undefined ? { greeting: agentConfig.greeting } : {}),
      },
      toolSchemas: toolSchemas as OpenaiRealtimeToolSchema[],
      toolChoice: agentConfig.toolChoice ?? "auto",
      callbacks,
      sid: sessionOpts.id,
      agent: sessionOpts.agent,
      inputSampleRate: s2sConfig.inputSampleRate,
      outputSampleRate: s2sConfig.outputSampleRate,
      skipGreeting: sessionOpts.skipGreeting ?? false,
      ...(createOpenaiRealtimeWebSocket ? { createWebSocket: createOpenaiRealtimeWebSocket } : {}),
      logger,
    });
  }

  function buildAssemblyS2sTransport(args: {
    sessionOpts: SessionOpts;
    systemPrompt: string;
    callbacks: TransportCallbacks;
  }): Transport {
    const { sessionOpts, systemPrompt, callbacks } = args;
    return createS2sTransport({
      apiKey: env.ASSEMBLYAI_API_KEY ?? "",
      s2sConfig,
      sessionConfig: {
        systemPrompt,
        tools: toolSchemas as import("./s2s.ts").S2sToolSchema[],
        ...(agentConfig.greeting !== undefined ? { greeting: agentConfig.greeting } : {}),
      },
      callbacks,
      sid: sessionOpts.id,
      agent: sessionOpts.agent,
      ...(createWebSocket ? { createWebSocket } : {}),
      logger,
    });
  }

  function buildTransport(args: {
    sessionOpts: SessionOpts;
    systemPrompt: string;
    callbacks: TransportCallbacks;
  }): Transport {
    if (pipelineProviders) {
      return buildPipelineTransport({ ...args, providers: pipelineProviders });
    }
    if (agent.s2s !== undefined) {
      const kind = descriptorKind(agent.s2s);
      if (kind === OPENAI_REALTIME_KIND) {
        return buildOpenaiRealtimeTransport(args);
      }
      throw new Error(`Unknown s2s provider kind: ${kind ?? "<missing>"}`);
    }
    return buildAssemblyS2sTransport(args);
  }

  function createSession(sessionOpts: SessionOpts): SessionCore {
    sinkMap.set(sessionOpts.id, sessionOpts.client);

    const isPipeline = Boolean(pipelineProviders);
    const hasTools = toolSchemas.length > 0 || (agentConfig.builtinTools?.length ?? 0) > 0;
    const systemPrompt = buildSystemPrompt(agentConfig, {
      hasTools,
      voice: true,
      toolGuidance,
    });

    // Late-bound reference: callbacks are constructed before SessionCore exists,
    // so we capture a reference and fill it in below.
    let core: SessionCore | null = null;
    function bindCore(): SessionCore {
      if (!core) throw new Error("SessionCore not yet created");
      return core;
    }

    const callbacks: TransportCallbacks = {
      onReplyStarted: (replyId) => bindCore().onReplyStarted(replyId),
      onReplyDone: () => bindCore().onReplyDone(),
      onCancelled: () => bindCore().onCancelled(),
      onAudioChunk: (bytes) => bindCore().onAudioChunk(bytes),
      onAudioDone: () => bindCore().onAudioDone(),
      onUserTranscript: (text) => bindCore().onUserTranscript(text),
      onAgentTranscript: (text, interrupted) => bindCore().onAgentTranscript(text, interrupted),
      // Pipeline: tools execute inside streamText; forward the call to the
      // client sink for UI observability only. Going through SessionCore.onToolCall
      // would re-execute the tool and leave pendingTools non-empty, hanging the turn.
      onToolCall: isPipeline
        ? (id, name, args) =>
            sessionOpts.client.event({ type: "tool_call", toolCallId: id, toolName: name, args })
        : (id, name, args) => bindCore().onToolCall(id, name, args),
      // Pipeline: emit `tool_call_done` when streamText surfaces the
      // `tool-result` part so the UI can flip status from pending → done.
      // S2S transports never set this; SessionCore.onToolCall emits done itself.
      ...(isPipeline
        ? {
            onToolCallDone: (id: string, result: string) =>
              sessionOpts.client.event({ type: "tool_call_done", toolCallId: id, result }),
          }
        : {}),
      onError: (code, message) => bindCore().onError(code, message),
      onSpeechStarted: () => bindCore().onSpeechStarted(),
      onSpeechStopped: () => bindCore().onSpeechStopped(),
    };

    const transport = buildTransport({
      sessionOpts,
      systemPrompt,
      callbacks,
    });

    core = createSessionCore({
      id: sessionOpts.id,
      agent: sessionOpts.agent,
      client: sessionOpts.client,
      agentConfig,
      executeTool,
      transport,
      logger,
    });

    return core;
  }

  // ── AgentRuntime methods ──────────────────────────────────────────────

  function startSession(ws: SessionWebSocket, startOpts?: SessionStartOptions): void {
    const resumeFrom = startOpts?.resumeFrom;
    const userOnSessionEnd = startOpts?.onSessionEnd;
    wireSessionSocket(ws, {
      sessions,
      createSession: (sid, client) =>
        createSession({
          id: sid,
          agent: agent.name,
          client,
          skipGreeting: startOpts?.skipGreeting ?? false,
        }),
      readyConfig,
      logger,
      ...(startOpts?.logContext ? { logContext: startOpts.logContext } : {}),
      ...(startOpts?.onOpen ? { onOpen: startOpts.onOpen } : {}),
      ...(startOpts?.onClose ? { onClose: startOpts.onClose } : {}),
      ...(startOpts?.onSinkCreated ? { onSinkCreated: startOpts.onSinkCreated } : {}),
      onSessionEnd: (sid) => {
        sinkMap.delete(sid);
        stateMap.delete(sid);
        userOnSessionEnd?.(sid);
      },
      ...(sessionStartTimeoutMs !== undefined ? { sessionStartTimeoutMs } : {}),
      ...(resumeFrom ? { resumeFrom } : {}),
    });
  }

  async function shutdown(): Promise<void> {
    if (sessions.size === 0) return;
    try {
      const results = await pTimeout(
        Promise.allSettled([...sessions.values()].map((s) => s.stop())),
        { milliseconds: shutdownTimeoutMs },
      );
      for (const r of results) {
        if (r.status === "rejected")
          logger.warn(`Session stop failed during shutdown: ${r.reason}`);
      }
    } catch {
      logger.warn(
        `Shutdown timeout (${shutdownTimeoutMs}ms) exceeded — force-closing ${sessions.size} remaining session(s)`,
      );
    }
    sessions.clear();
    sinkMap.clear();
  }

  return {
    executeTool,
    toolSchemas,
    createSession,
    startSession,
    shutdown,
    readyConfig,
  };
}
