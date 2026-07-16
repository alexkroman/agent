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
import { DEFAULT_BUILTIN_TOOLS, DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import { buildReadyConfig, type ReadyConfig } from "../sdk/protocol.ts";
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
import { resolveAllBuiltins, SANDBOX_ONLY_BUILTINS } from "./builtin-tools.ts";
import { createMemoryVector } from "./memory-vector.ts";
import {
  resolveLlmIfDescriptor,
  resolveSttIfDescriptor,
  resolveTtsIfDescriptor,
} from "./providers/resolve.ts";
import { resolveKv } from "./providers/resolve-kv.ts";
import { resolveVector } from "./providers/resolve-vector.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime-config.ts";
import { createTransportFactory, type TransportSessionOpts } from "./runtime-transport.ts";
import type { Runtime, RuntimeOptions, SessionStartOptions } from "./runtime-types.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";
import { type ExecuteTool, executeToolCall } from "./tool-executor.ts";
import type { TransportCallbacks } from "./transports/types.ts";
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

/**
 * Resolve builtins for the sandbox/relay tool path. Platform callers
 * (aai-server/sandbox.ts) pre-resolve builtins and pass `builtinDefs` with
 * schemas/guidance already merged into `toolSchemas`/`toolGuidance`; relay
 * callers (host mode, e.g. a tau2 harness supplying its own tools) get the
 * agent's builtins resolved and merged here, so relayed sessions expose
 * think/remember/recall/calculate too. A relayed tool with the same name
 * wins — the colliding builtin is dropped from both dispatch and schemas so
 * the host never shadows a tool the client expects to execute.
 */
function resolveSandboxBuiltins(
  agent: AgentDef,
  opts: RuntimeOptions,
  fetchOpt: { fetch: typeof globalThis.fetch } | undefined,
): {
  defs: NonNullable<RuntimeOptions["builtinDefs"]>;
  schemas: ToolSchema[];
  guidance: string[];
} {
  const providedSchemas = opts.toolSchemas ?? [];
  if (opts.builtinDefs) {
    return { defs: opts.builtinDefs, schemas: providedSchemas, guidance: opts.toolGuidance ?? [] };
  }
  const relayedNames = new Set(providedSchemas.map((s) => s.name));
  const names = (agent.builtinTools ?? DEFAULT_BUILTIN_TOOLS).filter(
    (name) => !relayedNames.has(name),
  );
  const builtins = resolveAllBuiltins(names, fetchOpt);
  return {
    defs: builtins.defs,
    schemas: [...providedSchemas, ...builtins.schemas],
    guidance: [...(opts.toolGuidance ?? []), ...builtins.guidance],
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
    kv,
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
  const effectiveProviders = resolveEffectiveProviders(opts, agent);

  // Resolve descriptors from manifest if present; otherwise use the
  // supplied (or default) instances.
  const slug = agent.name ?? "local";
  // Lazy default: only construct the local unstorage KV when neither the
  // agent manifest nor the caller supplied one — a declared `kv:` descriptor
  // would otherwise shadow (and waste) an eagerly-built instance.
  const resolvedKv = agent.kv ? resolveKv(agent.kv, env, "") : (kv ?? createLocalKv());
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
    // Sandbox mode — custom tools are RPC-backed; builtins run host-side.
    const resolved = resolveSandboxBuiltins(agent, opts, builtinFetchOpt);
    const builtinDefs = resolved.defs;
    toolSchemas = resolved.schemas;
    toolGuidance = resolved.guidance;
    const rpcExecuteTool = opts.executeTool;
    const frozenEnv = Object.freeze({ ...env });

    executeTool = async (name, args, sessionId, messages, callOpts) => {
      // Handle builtins on the host (where SSRF-safe fetch lives) — EXCEPT
      // sandbox-only builtins (see SANDBOX_ONLY_BUILTINS), which execute
      // untrusted JS and must run inside the guest sandbox (gVisor/Deno),
      // never on the host. They are delegated via RPC like custom tools;
      // the guest harness runs them directly.
      if (builtinDefs[name] && !SANDBOX_ONLY_BUILTINS.has(name)) {
        const tool = builtinDefs[name];
        return executeToolCall(name, args, {
          tool,
          env: frozenEnv,
          sessionId: sessionId ?? "",
          kv: resolvedKv,
          vector: resolvedVector,
          messages,
          logger,
          signal: callOpts?.signal,
        });
      }
      // Delegate custom tools (and run_code) to the isolate via RPC. Forward
      // `callOpts` (which carries `toolCallId`) — the relay executor needs it to
      // correlate the client's `tool_result`; dropping it makes every relayed
      // tool call fail with "invoked without a toolCallId" in pipeline mode.
      return rpcExecuteTool(name, args, sessionId, messages, callOpts);
    };
  } else {
    // Self-hosted mode — in-process tool execution. A custom tool with the
    // same name as a builtin wins: the builtin is dropped from both dispatch
    // and schemas rather than emitting a duplicate schema name to the LLM.
    const customNames = new Set(Object.keys(agent.tools ?? {}));
    const builtinNames = (agent.builtinTools ?? DEFAULT_BUILTIN_TOOLS).filter(
      (name) => !customNames.has(name),
    );
    const builtins = resolveAllBuiltins(builtinNames, builtinFetchOpt);
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

    executeTool = async (name, args, sessionId, messages, callOpts) => {
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
        // Turn cancellation (barge-in/reset/stop) unblocks the tool await.
        signal: callOpts?.signal,
      });
    };
  }

  // Resolve pipeline providers once per runtime (not per session). Each
  // session reuses the same opener / LanguageModel — the opener's `open()`
  // mints the per-session stream inside.
  const pipelineProviders = resolvePipelineProviders(effectiveProviders, env);

  // Transport construction (pipeline vs OpenAI Realtime vs AssemblyAI S2S)
  // lives in runtime-transport.ts; the factory closes over the resolved
  // runtime state above.
  const buildTransport = createTransportFactory({
    agent,
    agentConfig,
    toolSchemas,
    executeTool,
    env,
    s2sConfig,
    effectiveProviders: { stt: effectiveProviders.stt, tts: effectiveProviders.tts },
    pipelineProviders,
    createWebSocket,
    createOpenaiRealtimeWebSocket,
    logger,
  });

  function createSession(sessionOpts: TransportSessionOpts): SessionCore {
    sinkMap.set(sessionOpts.id, sessionOpts.client);

    const isPipeline = Boolean(pipelineProviders);
    // Relay (host) mode: the relay `executeTool` emits the client-facing
    // `tool_call` itself (mirrors session-core's `!opts.onToolResult` guard).
    const isRelay = Boolean(opts.onToolResult);
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

    // onToolCall wiring, by transport + relay mode:
    // - S2S: route through SessionCore, which executes and emits done itself.
    // - Pipeline in-process: tools run inside streamText; forward to the client
    //   sink for UI observability only (routing through SessionCore would
    //   re-execute the tool and hang the turn on non-empty pendingTools).
    // - Pipeline relay: the relay executeTool already emitted the tool_call to
    //   the client (the executor); a second emit here would be a duplicate frame
    //   the client runs twice — corrupting write state, doubling read latency.
    let onToolCall: TransportCallbacks["onToolCall"];
    if (!isPipeline) {
      onToolCall = (id, name, args) => bindCore().onToolCall(id, name, args);
    } else if (isRelay) {
      onToolCall = () => undefined;
    } else {
      onToolCall = (id, name, args) =>
        sessionOpts.client.event({ type: "tool_call", toolCallId: id, toolName: name, args });
    }

    const callbacks: TransportCallbacks = {
      onReplyStarted: (replyId) => bindCore().onReplyStarted(replyId),
      onReplyDone: () => bindCore().onReplyDone(),
      onCancelled: () => bindCore().onCancelled(),
      onAudioChunk: (bytes) => bindCore().onAudioChunk(bytes),
      onAudioDone: () => bindCore().onAudioDone(),
      onUserTranscript: (text) => bindCore().onUserTranscript(text),
      onAgentTranscript: (text, interrupted) => bindCore().onAgentTranscript(text, interrupted),
      onToolCall,
      // Pipeline: emit `tool_call_done` when streamText surfaces the
      // `tool-result` part so the UI can flip status from pending → done.
      // S2S transports never set this; SessionCore.onToolCall emits done itself.
      // Suppressed in relay mode: the client owns the tool lifecycle there and a
      // duplicate `tool_call_done` would only echo a result it already computed.
      ...(isPipeline && !isRelay
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
      ...(opts.onToolResult ? { onToolResult: opts.onToolResult } : {}),
    });

    // Tie map cleanup to the session's own stop() so it happens on every
    // teardown path — including a direct `runtime.createSession()` caller that
    // never goes through startSession's onSessionEnd hook (which would
    // otherwise leak the sinkMap/stateMap entry). Delete is idempotent, so the
    // onSessionEnd path staying is harmless.
    const stopCore = core.stop.bind(core);
    core.stop = async () => {
      try {
        await stopCore();
      } finally {
        sinkMap.delete(sessionOpts.id);
        stateMap.delete(sessionOpts.id);
      }
    };

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
