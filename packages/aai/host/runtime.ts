// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent runtime — the execution engine for voice agents.
 *
 * {@link createRuntime} builds the single execution engine used by both
 * self-hosted servers and the platform sandbox. It wires up tool execution,
 * lifecycle hooks, and session management.
 */

import pTimeout, { TimeoutError } from "p-timeout";
import { toAgentConfig } from "../sdk/_internal-types.ts";
import { assertProviderTriple, type SessionMode } from "../sdk/config-rules.ts";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../sdk/constants.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { createOwnedMap } from "../sdk/owned-map.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import { buildReadyConfig, type ReadyConfig } from "../sdk/protocol.ts";
import { defaultProviders } from "../sdk/providers/_default-providers.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "../sdk/providers.ts";
import { buildSystemPrompt } from "../sdk/system-prompt.ts";
import type { AgentDef } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";
import { createPostgresDb } from "./postgres-db.ts";
import { describeResolvedProviders } from "./providers/_provider-settings.ts";
import { resolveLlm, resolveStt, resolveTts } from "./providers/resolve.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG, pinAssemblyS2sRates } from "./runtime-config.ts";
import { setupTools } from "./runtime-tools.ts";
import {
  createTransportFactory,
  type ResolvedPipelineProviders,
  type TransportSessionOpts,
  usesAssemblyS2s,
} from "./runtime-transport.ts";
import type { Runtime, RuntimeOptions, SessionStartOptions } from "./runtime-types.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";
import { createStateSweeps } from "./session-state-sweeps.ts";
import type { TransportCallbacks } from "./transports/types.ts";
import { buildWorkflowClient } from "./workflow-runtime.ts";
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
  s2s: AgentDef["s2s"];
  mode: SessionMode;
} {
  const stt = opts.stt ?? agent.stt;
  const llm = opts.llm ?? agent.llm;
  const tts = opts.tts ?? agent.tts;
  // A full provider triple passed as RuntimeOptions replaces the agent's
  // session-mode declaration entirely, `s2s` field included — the platform
  // path uses opts as an override, not a merge.
  const s2s = stt && llm && tts ? undefined : agent.s2s;
  // Pipeline stages not declared anywhere → filled from the all-AssemblyAI
  // pipeline, matching toAgentConfig. S2S requires an explicit
  // `s2s` descriptor (`assemblyAIS2s()`), so a config that loses its
  // providers can no longer silently run S2S — this mirrors, not replaces,
  // the "never let S2S be a fallback" rule in runtime-transport.ts.
  const defaults = defaultProviders({ stt, llm, tts, s2s });
  if (defaults) {
    return {
      stt: stt ?? defaults.stt,
      llm: llm ?? defaults.llm,
      tts: tts ?? defaults.tts,
      s2s: undefined,
      mode: "pipeline",
    };
  }
  return { stt, llm, tts, s2s, mode: assertProviderTriple(stt, llm, tts, s2s) };
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
    tts: resolveTts(p.tts),
  };
}

/**
 * Create an agent runtime — the execution engine for a voice agent.
 *
 * Merges built-in and custom tool definitions, builds their tool schemas, and
 * owns per-session transports: pipeline mode (STT → LLM → TTS, the default)
 * or S2S mode when the agent declares an `s2s` descriptor.
 *
 * @param opts - Runtime configuration. See {@link RuntimeOptions}.
 * @returns A {@link Runtime} with tool execution, schemas, and session
 *   management.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { createRuntime, type SessionWebSocket } from "@alexkroman1/aai/runtime";
 *
 * const runtime = createRuntime({ agent: agent({ name: "My Agent" }), env: {} });
 * // wire a connected WebSocket to a session:
 * declare const ws: SessionWebSocket;
 * runtime.startSession(ws);
 * await runtime.shutdown();
 * ```
 *
 * @public
 */
export function createRuntime(opts: RuntimeOptions): Runtime {
  const {
    agent,
    env,
    createWebSocket,
    createOpenaiRealtimeWebSocket,
    logger = consoleLogger,
    s2sConfig: requestedS2sConfig = DEFAULT_S2S_CONFIG,
    sessionStartTimeoutMs,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  } = opts;
  // Providers may come from RuntimeOptions (platform path passes them
  // explicitly) or from the agent's own `stt`/`llm`/`tts` fields (the `aai
  // dev` path calls createRuntime({ agent, env }) with no provider opts).
  const effectiveProviders = resolveEffectiveProviders(opts, agent);

  const slug = agent.name;
  // Credentials resolve from `providerEnv` (defaults to `env`); `env` alone is
  // what agent tool code sees as `ctx.env`. See RuntimeOptions.providerEnv.
  const providerEnv = opts.providerEnv ?? env;
  // ctx.db: a caller-injected Db wins (the platform passes one when storage
  // is enabled for the app); otherwise a DATABASE_URL in the provider env
  // (self-hosted `aai dev` reads the project .env) connects one here.
  // Neither means ctx.db access throws (see tool-executor.ts).
  // The runtime owns — and must close on dispose — only the connection it
  // opened itself; an injected Db stays the caller's to dispose. Without the
  // close, `aai dev` (which rebuilds the runtime on every file save) strands
  // the previous pool on each reload.
  const ownedDb =
    !opts.db && providerEnv.DATABASE_URL
      ? createPostgresDb({ url: providerEnv.DATABASE_URL })
      : undefined;
  const resolvedDb = opts.db ?? ownedDb;

  // Validate against the *effective* providers, not the agent's own fields.
  // Providers may arrive as runtime options rather than on the agent object,
  // and reading `agent` alone once resolved mode "s2s" for every deployed
  // pipeline agent, so `assertPipelineTuning` rejected all six voice tuning
  // knobs at session start — a deployed agent with `holdPhrase` (a tuning
  // field since removed) died with "holdPhrase requires pipeline mode (stt,
  // llm, and tts all set)" while
  // listing all three providers — and left `agentConfig.mode` wrong for
  // everything downstream that reads it.
  const agentConfig = toAgentConfig({
    ...agent,
    stt: effectiveProviders.stt,
    llm: effectiveProviders.llm,
    tts: effectiveProviders.tts,
    s2s: effectiveProviders.s2s,
  });

  // Report the resolved mode once per runtime. A pipeline agent whose providers
  // fail to reach the runtime does not error — before the pipeline-by-default
  // flip it ran a perfectly healthy S2S session instead — so "which transport
  // is this agent on" has to be answerable from one log line rather than
  // inferred from the shape of the message stream.
  //
  // Each stage reports its EFFECTIVE settings, not just its kind: almost every
  // one of them is a default nobody wrote down (endpointing window, Voice
  // Focus threshold, gateway model id, TTS voice), and those are the values a
  // misbehaving session gets blamed on. See _provider-settings.ts.
  logger.info("Session mode resolved", {
    slug,
    mode: effectiveProviders.mode,
    ...describeResolvedProviders(effectiveProviders),
  });
  // Owned maps because teardown is async on both: a reconnect resuming the
  // same session id re-claims the key while the old session's stop() drains,
  // and release-by-claim is what keeps that drain from evicting the
  // successor's entry (see sdk/owned-map.ts).
  const sessions = createOwnedMap<string, SessionCore>();
  const sinkMap = createOwnedMap<string, ClientSink>();
  // The Voice Agent API accepts exactly one sample rate and honours no
  // declaration to the contrary, so its rates are pinned rather than
  // negotiated. Pinned BEFORE the ready config is built, because that frame is
  // what tells the client what to capture and play: the two numbers disagreeing
  // is the whole bug. A host-mode client that asked for something else was
  // already refused at the handshake (`assertHostRatesSupported`), so nothing
  // reaching here can be surprised by the override.
  const s2sConfig = usesAssemblyS2s(agent)
    ? pinAssemblyS2sRates(requestedS2sConfig, logger)
    : requestedS2sConfig;
  const readyConfig: ReadyConfig = buildReadyConfig(s2sConfig);

  // Per-session tool state (self-hosted mode only); cleaned up on session
  // end, but only after the resume grace window — see session-state-sweeps.ts.
  const stateMap = new Map<string, Record<string, unknown>>();
  const stateSweeps = createStateSweeps(stateMap);

  // `ctx.workflows`, built once per runtime rather than per session: a run
  // outlives the session that started it, so nothing about the client is
  // session-scoped. Undefined for an agent that declares none, which is what
  // makes the executor's rejecting stub name the right reason.
  const workflows = buildWorkflowClient(agent, resolvedDb, logger);

  const { executeTool, toolSchemas, toolGuidance, pushStateSnapshot } = setupTools({
    agent,
    opts,
    llm: effectiveProviders.llm,
    env,
    providerEnv,
    resolvedDb,
    workflows,
    logger,
    sinkMap,
    stateMap,
  });

  // Resolve pipeline providers once per runtime (not per session). Each
  // session reuses the same opener / LanguageModel — the opener's `open()`
  // mints the per-session stream inside. Credentials come from providerEnv
  // (like every other provider-facing path here): resolveLlm throws on a
  // missing key, so resolving from `env` bypassed withHostCredentialFallback
  // and killed `aai dev` for pipeline agents on shell-exported keys.
  const pipelineProviders = resolvePipelineProviders(effectiveProviders, providerEnv);

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
    // A resume under this id (same key, new socket) reclaims its tool state —
    // cancel the sweep the previous session's stop() scheduled.
    stateSweeps.cancel(sessionOpts.id);
    const releaseSink = sinkMap.claim(sessionOpts.id, sessionOpts.client);
    // A resumed session still holds its state, and the new socket has never
    // seen it — without this the client renders empty until some later tool
    // call happens to change something, which it may never do.
    pushStateSnapshot?.(sessionOpts.id, sessionOpts.client);

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
      onAgentTranscriptPartial: (text) => bindCore().onAgentTranscriptPartial(text),
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
      onError: (code, message, errOpts) => bindCore().onError(code, message, errOpts),
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
    // otherwise leak the sinkMap/stateMap entry). Releasing the sink claim
    // guards the reconnect-resume race: an old session's async stop() can
    // settle after a resumed session re-claimed the same id, and a bare key
    // delete would then wipe the NEW session's sink (ctx.send no-ops) and
    // tool state — releaseSink no-ops (returns false) once that happens.
    const stopCore = core.stop.bind(core);
    core.stop = async () => {
      try {
        await stopCore();
      } finally {
        if (releaseSink()) {
          // Tool state outlives the socket: keep it for the resume grace
          // window so a `?sessionId=<id>` reconnect finds its ctx.state.
          stateSweeps.schedule(sessionOpts.id);
        }
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
      ...omitUndefined({ audioLeadMs: startOpts?.audioLeadMs }),
      // sinkMap/stateMap cleanup lives in the identity-guarded stop() wrapper
      // (createSession) — a key delete here would hit the resumed session's
      // entries when an old session's stop settles after a reconnect.
      onSessionEnd: (sid, sink) => {
        userOnSessionEnd?.(sid, sink);
      },
      ...omitUndefined({ sessionStartTimeoutMs }),
      ...(resumeFrom ? { resumeFrom } : {}),
    });
  }

  function releaseResources(): void {
    sessions.clear();
    sinkMap.clear();
    // Force-close on timeout skips the per-session stop wrapper's stateMap
    // cleanup (its sink-identity check fails against the cleared map), so clear
    // it here too or timed-out sessions leak their tool state permanently.
    stateMap.clear();
    // Pending grace-window sweeps have nothing left to reclaim.
    stateSweeps.clear();
    // Release a runtime-owned DB pool (see the resolution comment above).
    // Fire-and-forget: releaseResources is sync and a drain failure on a
    // dying pool is not actionable.
    void ownedDb?.close().catch(() => undefined);
  }

  async function shutdown(): Promise<void> {
    if (sessions.size === 0) {
      releaseResources();
      return;
    }
    try {
      const results = await pTimeout(
        Promise.allSettled([...sessions.values()].map((s) => s.stop())),
        { milliseconds: shutdownTimeoutMs },
      );
      for (const r of results) {
        if (r.status === "rejected")
          logger.warn(`Session stop failed during shutdown: ${r.reason}`);
      }
    } catch (err) {
      // allSettled never rejects, so this is normally pTimeout's TimeoutError
      // — but don't mislabel anything else (e.g. a throwing logger above).
      logger.warn(
        err instanceof TimeoutError
          ? `Shutdown timeout (${shutdownTimeoutMs}ms) exceeded — force-closing ${sessions.size} remaining session(s)`
          : `Shutdown failed: ${errorMessage(err)} — force-closing ${sessions.size} remaining session(s)`,
      );
    }
    releaseResources();
  }

  return {
    executeTool,
    toolSchemas,
    createSession,
    startSession,
    shutdown,
    readyConfig,
    // Exposed rather than kept private because tool code is not the only caller:
    // `createServer` serves the workflow HTTP API from exactly this client, so a
    // page and a `curl` reach the same runs a tool does. One client per runtime,
    // not one per surface — two would index correlation keys separately.
    workflows,
  };
}
