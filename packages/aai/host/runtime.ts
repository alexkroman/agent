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
import { DEEPGRAM_KIND } from "../sdk/providers/stt/deepgram.ts";
import { RIME_KIND } from "../sdk/providers/tts/rime.ts";
import {
  assertProviderTriple,
  type KvProvider,
  type LlmProvider,
  type SttOpener,
  type SttProvider,
  type TtsOpener,
  type TtsProvider,
  type VectorProvider,
} from "../sdk/providers.ts";
import { buildSystemPrompt } from "../sdk/system-prompt.ts";
import type { AgentDef } from "../sdk/types.ts";
import { toolError } from "../sdk/utils.ts";
import type { Vector } from "../sdk/vector.ts";
import { resolveAllBuiltins } from "./builtin-tools.ts";
import {
  resolveApiKey,
  resolveKv,
  resolveLlm,
  resolveStt,
  resolveTts,
  resolveVector,
} from "./providers/resolve.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime-config.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";
import { type ExecuteTool, executeToolCall } from "./tool-executor.ts";
import { createPipelineTransport } from "./transports/pipeline-transport.ts";
import { createS2sTransport } from "./transports/s2s-transport.ts";
import type { Transport, TransportCallbacks } from "./transports/types.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws-handler.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the API key env-var for the configured STT provider.
 *
 * Each STT provider uses its own env var (e.g. `ASSEMBLYAI_API_KEY`,
 * `DEEPGRAM_API_KEY`). We read the kind from the descriptor if it is one;
 * pre-resolved openers have no kind field so we fall back to AssemblyAI for
 * backward compatibility (openers supply their own key at open-time anyway).
 */
function resolveSttApiKey(
  stt: SttProvider | SttOpener | undefined,
  env: Record<string, string>,
): string {
  // SttProvider descriptors carry a `kind` field; SttOpener does not.
  const kind =
    stt != null && "kind" in stt && typeof (stt as SttProvider).kind === "string"
      ? (stt as SttProvider).kind
      : undefined;
  if (kind === DEEPGRAM_KIND) return resolveApiKey("DEEPGRAM_API_KEY", env);
  // Default: ASSEMBLYAI_KIND or pre-resolved opener (backward compat).
  return resolveApiKey("ASSEMBLYAI_API_KEY", env);
}

/**
 * Resolve the API key env-var for the configured TTS provider.
 *
 * Each TTS provider uses its own env var (e.g. `CARTESIA_API_KEY`,
 * `RIME_API_KEY`). We read the kind from the descriptor if it is one;
 * pre-resolved openers have no kind field so we fall back to Cartesia for
 * backward compatibility (openers supply their own key at open-time anyway).
 */
function resolveTtsApiKey(
  tts: TtsProvider | TtsOpener | undefined,
  env: Record<string, string>,
): string {
  // TtsProvider descriptors carry a `kind` field; TtsOpener does not.
  const kind =
    tts != null && "kind" in tts && typeof (tts as TtsProvider).kind === "string"
      ? (tts as TtsProvider).kind
      : undefined;
  if (kind === RIME_KIND) return resolveApiKey("RIME_API_KEY", env);
  // Default: CARTESIA_KIND or pre-resolved opener (backward compat).
  return resolveApiKey("CARTESIA_API_KEY", env);
}

// ─── Runtime adapter (formerly adapter.ts) ──────────────────────────────────

/** Per-session options passed to {@link AgentRuntime.startSession}. */
export type SessionStartOptions = {
  skipGreeting?: boolean;
  resumeFrom?: string;
  logContext?: Record<string, string>;
  onOpen?: () => void;
  onClose?: () => void;
  /** Called with session ID after session cleanup, for guest state cleanup. */
  onSessionEnd?: (sessionId: string) => void;
  /** Called with session ID and client sink after session setup. Used by sandbox to route custom events. */
  onSinkCreated?: (sessionId: string, sink: ClientSink) => void;
};

/**
 * Common interface for agent runtimes.
 *
 * Implemented by {@link createRuntime} and the platform sandbox.
 */
export type AgentRuntime = {
  startSession(ws: SessionWebSocket, opts?: SessionStartOptions): void;
  shutdown(): Promise<void>;
  readonly readyConfig: ReadyConfig;
};

// ─── Runtime implementation ──────────────────────────────────────────────────

/**
 * Distinguish a descriptor (`{ kind, options }`) from an already-resolved
 * opener / `LanguageModel`. The production path always passes descriptors;
 * openers are a test escape hatch (fakes in `_pipeline-test-fakes.ts`).
 * STT/TTS openers are identified by the `open` method, `LanguageModel` by
 * its `specificationVersion` field — both absent on descriptors.
 */
function resolveSttIfDescriptor(value: SttProvider | SttOpener): SttOpener {
  return "open" in value ? value : resolveStt(value);
}

function resolveTtsIfDescriptor(value: TtsProvider | TtsOpener): TtsOpener {
  return "open" in value ? value : resolveTts(value);
}

function resolveLlmIfDescriptor(
  value: LlmProvider | LanguageModel,
  env: Record<string, string>,
): LanguageModel {
  // LanguageModel can be a string (model-id shortcut) or an object with
  // `specificationVersion`; descriptors are plain `{ kind, options }` objects.
  if (typeof value === "string") return value;
  return "specificationVersion" in value ? value : resolveLlm(value, env);
}

/** Create an in-memory KV store (default for self-hosted). */
function createLocalKv(): Kv {
  return createUnstorageKv({ storage: createStorage() });
}

/** Distinguish a `Kv` instance (has `get`/`set`/`delete`) from a `KvProvider` descriptor (has `kind`). */
function isKvDescriptor(value: Kv | KvProvider): value is KvProvider {
  return "kind" in value && typeof (value as KvProvider).kind === "string";
}

/** Distinguish a `Vector` instance from a `VectorProvider` descriptor. */
function isVectorDescriptor(value: Vector | VectorProvider): value is VectorProvider {
  return "kind" in value && typeof (value as VectorProvider).kind === "string";
}

function resolveKvIfDescriptor(value: Kv | KvProvider, env: Record<string, string>): Kv {
  return isKvDescriptor(value) ? resolveKv(value, env) : value;
}

function resolveVectorIfDescriptor(
  value: Vector | VectorProvider,
  env: Record<string, string>,
): Vector {
  return isVectorDescriptor(value) ? resolveVector(value, env) : value;
}

/**
 * Configuration for {@link createRuntime}.
 *
 * Configures the agent, environment, KV store, logging, and S2S connection.
 *
 * @public
 */
export type RuntimeOptions = {
  // biome-ignore lint/suspicious/noExplicitAny: accepts any state type
  agent: AgentDef<any>;
  env: Record<string, string>;
  /**
   * KV store. Accepts either a {@link Kv} instance (self-hosted escape
   * hatch) or a {@link KvProvider} descriptor produced by factories like
   * `memory()` / `upstash(...)` / `unstorage(...)`. Defaults to in-memory.
   */
  kv?: Kv | KvProvider | undefined;
  /**
   * Vector store. Accepts either a {@link Vector} instance or a
   * {@link VectorProvider} descriptor (e.g. `pinecone({...})`). When unset,
   * `ctx.vector` throws on access.
   */
  vector?: Vector | VectorProvider | undefined;
  /** Custom WebSocket factory for the S2S connection (useful for testing). */
  createWebSocket?: CreateS2sWebSocket | undefined;
  logger?: Logger | undefined;
  s2sConfig?: S2SConfig | undefined;
  /**
   * Timeout in ms for `session.start()` (S2S connection setup).
   * Defaults to 10 000 (10 s).
   */
  sessionStartTimeoutMs?: number | undefined;
  /**
   * Maximum time in milliseconds to wait for sessions to stop during
   * {@link AgentRuntime.shutdown | shutdown()}. Defaults to `30_000` (30 s).
   */
  shutdownTimeoutMs?: number | undefined;
  /**
   * Override tool execution. When provided, `createRuntime` skips building
   * in-process tool definitions and uses this function instead. Used by the
   * platform sandbox to RPC tool calls to the isolate.
   */
  executeTool?: ExecuteTool | undefined;
  /**
   * Override tool schemas sent to the S2S API. Required when `executeTool`
   * is provided (the host doesn't have the tool definitions to derive schemas).
   */
  toolSchemas?: ToolSchema[] | undefined;
  /** System prompt guidance for builtin tools. Passed through in sandbox mode. */
  toolGuidance?: string[] | undefined;
  /**
   * Pre-resolved builtin tool definitions. When provided alongside `executeTool`
   * and `toolSchemas`, skips calling `resolveAllBuiltins` on the host.
   */
  builtinDefs?: Record<string, import("../sdk/types.ts").ToolDef> | undefined;
  /**
   * Override the fetch implementation used by built-in tools (web_search,
   * visit_webpage, fetch_json). Defaults to `globalThis.fetch`.
   *
   * In platform mode, pass an SSRF-safe fetch to prevent requests to
   * private/internal networks. In self-hosted mode, users may provide
   * their own fetch wrapper.
   */
  fetch?: typeof globalThis.fetch | undefined;
  /**
   * STT provider. Accepts either a descriptor ({@link SttProvider},
   * the normal production path) or a pre-resolved {@link SttOpener}
   * (test escape hatch). Must be set together with `llm` and `tts` to
   * route sessions through the pipeline path; leave all three unset for
   * the default AssemblyAI Streaming Speech-to-Speech (S2S) path.
   */
  stt?: SttProvider | SttOpener | undefined;
  /**
   * LLM provider. Accepts either a descriptor ({@link LlmProvider},
   * produced by factories like `anthropic(...)`) or a concrete Vercel AI
   * SDK `LanguageModel` (self-hosted / test escape hatch).
   */
  llm?: LlmProvider | LanguageModel | undefined;
  /**
   * TTS provider. Accepts either a descriptor ({@link TtsProvider})
   * or a pre-resolved {@link TtsOpener}.
   */
  tts?: TtsProvider | TtsOpener | undefined;
};

/**
 * The agent runtime returned by {@link createRuntime}.
 *
 * Satisfies {@link AgentRuntime} for use by transport code, and also exposes
 * lower-level helpers (`executeTool`, `hooks`, `toolSchemas`,
 * `createSession`) for testing and advanced usage.
 *
 * @public
 */
export type Runtime = AgentRuntime & {
  /** Execute a named tool with the given args, returning a JSON result string. */
  executeTool: ExecuteTool;
  /** Tool schemas registered with the S2S API (custom + built-in). */
  toolSchemas: ToolSchema[];
  /** Create a new voice session for a connected client (lower-level than startSession). */
  createSession(opts: {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
    resumeFrom?: string;
  }): SessionCore;
};

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
    createWebSocket,
    logger = consoleLogger,
    s2sConfig = DEFAULT_S2S_CONFIG,
    sessionStartTimeoutMs,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  } = opts;
  const kv: Kv = opts.kv ? resolveKvIfDescriptor(opts.kv, env) : createLocalKv();
  const vector: Vector | undefined = opts.vector
    ? resolveVectorIfDescriptor(opts.vector, env)
    : undefined;
  const mode = assertProviderTriple(opts.stt, opts.llm, opts.tts);
  const agentConfig = toAgentConfig(agent);
  const sessions = new Map<string, SessionCore>();
  const sinkMap = new Map<string, ClientSink>();
  const readyConfig: ReadyConfig = buildReadyConfig(s2sConfig);

  // When overrides are provided (sandbox mode), skip in-process tool setup
  let executeTool: ExecuteTool;
  let toolSchemas: ToolSchema[];
  let toolGuidance: string[] = [];

  const builtinFetchOpt = opts.fetch ? { fetch: opts.fetch } : undefined;

  if (opts.executeTool && opts.toolSchemas) {
    // Sandbox mode — custom tools are RPC-backed; builtins run host-side
    const builtinDefs =
      opts.builtinDefs ?? resolveAllBuiltins(agent.builtinTools ?? [], builtinFetchOpt).defs;
    const rpcExecuteTool = opts.executeTool;
    const frozenEnv = Object.freeze({ ...env });

    executeTool = async (name, args, sessionId, messages) => {
      // Handle builtins on the host (where SSRF-safe fetch lives)
      if (builtinDefs[name]) {
        const tool = builtinDefs[name];
        return executeToolCall(name, args, {
          tool,
          env: frozenEnv,
          sessionId: sessionId ?? "",
          kv,
          vector,
          messages,
          logger,
        });
      }
      // Delegate custom tools to the isolate via RPC
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

    const stateMap = new Map<string, Record<string, unknown>>();
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
        kv,
        vector,
        messages,
        logger,
        send: sink ? (event, data) => sink.event({ type: "custom_event", event, data }) : undefined,
      });
    };
  }

  // Resolve pipeline providers once per runtime (not per session). Each
  // session reuses the same opener / LanguageModel — the opener's `open()`
  // mints the per-session stream inside.
  const pipelineProviders =
    mode === "pipeline"
      ? {
          // biome-ignore lint/style/noNonNullAssertion: mode === "pipeline" ⇒ all three set
          stt: resolveSttIfDescriptor(opts.stt!),
          // biome-ignore lint/style/noNonNullAssertion: mode === "pipeline" ⇒ all three set
          llm: resolveLlmIfDescriptor(opts.llm!, env),
          // biome-ignore lint/style/noNonNullAssertion: mode === "pipeline" ⇒ all three set
          tts: resolveTtsIfDescriptor(opts.tts!),
        }
      : null;

  function createSession(sessionOpts: {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
    resumeFrom?: string;
  }): SessionCore {
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
      onError: (code, message) => bindCore().onError(code, message),
      onSpeechStarted: () => bindCore().onSpeechStarted(),
      onSpeechStopped: () => bindCore().onSpeechStopped(),
    };

    let transport: Transport;
    if (pipelineProviders) {
      transport = createPipelineTransport({
        sid: sessionOpts.id,
        agent: sessionOpts.agent,
        stt: pipelineProviders.stt,
        llm: pipelineProviders.llm,
        tts: pipelineProviders.tts,
        callbacks,
        sessionConfig: {
          systemPrompt,
          greeting: agentConfig.greeting,
          tools: toolSchemas,
        },
        toolSchemas,
        executeTool,
        providerKeys: {
          stt: resolveSttApiKey(opts.stt, env),
          tts: resolveTtsApiKey(opts.tts, env),
        },
        sttSampleRate: s2sConfig.inputSampleRate,
        ttsSampleRate: s2sConfig.outputSampleRate,
        maxSteps: agentConfig.maxSteps,
        toolChoice: agentConfig.toolChoice,
        skipGreeting: sessionOpts.skipGreeting ?? false,
        logger,
      });
    } else {
      transport = createS2sTransport({
        apiKey: env.ASSEMBLYAI_API_KEY ?? "",
        s2sConfig,
        sessionConfig: {
          systemPrompt,
          tools: toolSchemas as import("./s2s.ts").S2sToolSchema[],
          ...(agentConfig.greeting !== undefined ? { greeting: agentConfig.greeting } : {}),
        },
        toolSchemas: toolSchemas as import("./s2s.ts").S2sToolSchema[],
        callbacks,
        sid: sessionOpts.id,
        agent: sessionOpts.agent,
        ...(createWebSocket ? { createWebSocket } : {}),
        logger,
      });
    }

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
          ...(resumeFrom ? { resumeFrom } : {}),
        }),
      readyConfig,
      logger,
      ...(startOpts?.logContext ? { logContext: startOpts.logContext } : {}),
      ...(startOpts?.onOpen ? { onOpen: startOpts.onOpen } : {}),
      ...(startOpts?.onClose ? { onClose: startOpts.onClose } : {}),
      ...(startOpts?.onSinkCreated ? { onSinkCreated: startOpts.onSinkCreated } : {}),
      onSessionEnd: (sid) => {
        sinkMap.delete(sid);
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
