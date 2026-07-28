// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent runtime — the execution engine for voice agents.
 *
 * {@link createRuntime} builds the single execution engine used by both
 * self-hosted servers and the platform sandbox. It wires up tool execution,
 * lifecycle hooks, and session management.
 */

import pTimeout from "p-timeout";
import { createStorage } from "unstorage";
import { toAgentConfig } from "../sdk/_internal-types.ts";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import { buildReadyConfig, type ReadyConfig } from "../sdk/protocol.ts";
import { isTextOnlyTts } from "../sdk/providers/tts/none.ts";
import {
  assertProviderTriple,
  type LlmProvider,
  type SessionMode,
  type SttProvider,
  type TtsProvider,
} from "../sdk/providers.ts";
import { buildSystemPrompt } from "../sdk/system-prompt.ts";
import type { AgentDef } from "../sdk/types.ts";
import type { Vector } from "../sdk/vector.ts";
import { createMemoryVector } from "./memory-vector.ts";
import { resolveLlm, resolveStt, resolveTts } from "./providers/resolve.ts";
import { resolveKv } from "./providers/resolve-kv.ts";
import { resolveVector } from "./providers/resolve-vector.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime-config.ts";
import { setupTools } from "./runtime-tools.ts";
import {
  createTransportFactory,
  type ResolvedPipelineProviders,
  type TransportSessionOpts,
} from "./runtime-transport.ts";
import type { Runtime, RuntimeOptions, SessionStartOptions } from "./runtime-types.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";
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
  stt: SttProvider | undefined;
  llm: LlmProvider | undefined;
  tts: TtsProvider | undefined;
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
    stt: SttProvider | undefined;
    llm: LlmProvider | undefined;
    tts: TtsProvider | undefined;
  },
  env: Record<string, string>,
): ResolvedPipelineProviders | null {
  if (p.mode !== "pipeline" || !(p.stt && p.llm && p.tts)) return null;
  // The STT/TTS env vars travel with their openers, so nothing downstream has
  // to keep the raw descriptors around just to re-derive a credential.
  return {
    stt: resolveStt(p.stt),
    llm: resolveLlm(p.llm, env),
    // `tts: none()` = text-only replies: no opener, no credential — the
    // pipeline transport runs with a null TTS session.
    tts: isTextOnlyTts(p.tts) ? null : resolveTts(p.tts),
  };
}

/**
 * Build the connect-time protocol config. Text-only agents (tts: none())
 * tell the client up front that no audio frames will arrive, so it renders
 * text replies instead of expecting playback.
 */
function buildRuntimeReadyConfig(
  s2sConfig: { inputSampleRate: number; outputSampleRate: number },
  agent: AgentDef,
): ReadyConfig {
  return buildReadyConfig(s2sConfig, {
    ...(isTextOnlyTts(agent.tts) && { audioOut: false }),
  });
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
  // Credentials resolve from `providerEnv` (defaults to `env`); `env` alone is
  // what agent tool code sees as `ctx.env`. See RuntimeOptions.providerEnv.
  const providerEnv = opts.providerEnv ?? env;
  // Lazy default: only construct the local unstorage KV when neither the
  // agent manifest nor the caller supplied one — a declared `kv:` descriptor
  // would otherwise shadow (and waste) an eagerly-built instance.
  const resolvedKv = agent.kv ? resolveKv(agent.kv, providerEnv, "") : (kv ?? createLocalKv());
  const resolvedVector = agent.vector
    ? resolveVector(agent.vector, providerEnv, slug)
    : (vector ?? createLocalVector(slug));

  const agentConfig = toAgentConfig(agent);
  const sessions = new Map<string, SessionCore>();
  const sinkMap = new Map<string, ClientSink>();
  const readyConfig: ReadyConfig = buildRuntimeReadyConfig(s2sConfig, agent);

  // Per-session tool state (self-hosted mode only); cleaned up on session end.
  const stateMap = new Map<string, Record<string, unknown>>();

  const { executeTool, toolSchemas, toolGuidance } = setupTools({
    agent,
    opts,
    env,
    providerEnv,
    resolvedKv,
    resolvedVector,
    logger,
    sinkMap,
    stateMap,
  });

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
    // Transports open STT/TTS/LLM/S2S connections, so they resolve credentials
    // from providerEnv rather than the agent-visible env.
    env: providerEnv,
    s2sConfig,
    pipelineProviders,
    createWebSocket,
    createOpenaiRealtimeWebSocket,
    logger,
  });

  // buildSystemPrompt's inputs (agentConfig, tool presence, guidance) are all
  // fixed for the runtime's lifetime, but it stamps today's date via
  // Intl.DateTimeFormat — the most expensive thing on the session-start path
  // with no reason to be there. Cached per calendar day rather than hoisted
  // outright, so a replica that lives across midnight doesn't keep serving
  // yesterday's date.
  const hasToolsForPrompt = toolSchemas.length > 0 || (agentConfig.builtinTools?.length ?? 0) > 0;
  let promptCache: { day: string; text: string } | null = null;
  function systemPromptForToday(): string {
    const day = new Date().toDateString();
    if (promptCache?.day !== day) {
      promptCache = {
        day,
        text: buildSystemPrompt(agentConfig, {
          hasTools: hasToolsForPrompt,
          voice: true,
          toolGuidance,
        }),
      };
    }
    return promptCache.text;
  }

  function createSession(sessionOpts: TransportSessionOpts): SessionCore {
    sinkMap.set(sessionOpts.id, sessionOpts.client);

    const isPipeline = Boolean(pipelineProviders);
    // Relay (host) mode: the relay `executeTool` emits the client-facing
    // `tool_call` itself (mirrors session-core's `!opts.onToolResult` guard).
    const isRelay = Boolean(opts.onToolResult);
    const systemPrompt = systemPromptForToday();

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
      onUserTranscriptPartial: (text) => bindCore().onUserTranscriptPartial(text),
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
