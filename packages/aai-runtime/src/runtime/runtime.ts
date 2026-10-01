// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent runtime — the execution engine for voice agents.
 *
 * {@link createRuntime} builds the single execution engine used by both
 * self-hosted servers and the platform sandbox. It wires up tool execution,
 * lifecycle hooks, and session management.
 */

import { DEFAULT_SHUTDOWN_TIMEOUT_MS, systemPromptResolver } from "@alexkroman1/aai/host-internal";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { buildReadyConfig, type ReadyConfig } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { openAppDb } from "../app-db.ts";
import { consoleLogger } from "../logger.ts";
import { DEFAULT_S2S_CONFIG, pinAssemblyS2sRates } from "../s2s-config.ts";
import {
  createSessionDirectory,
  type SessionWebSocket,
  wireSessionSocket,
} from "../session/index.ts";
import { createClientToolBroker } from "../tools/index.ts";
import { platformGuestOptions } from "../workflow/platform-world.ts";
import { buildRunNotifier, buildWorkflowClient } from "../workflow/runtime.ts";
import { compileAgentRoutes } from "./agent-routes.ts";
import { registerConnector } from "./connect.ts";
import { createPipelineProviderResolver } from "./pipeline-providers.ts";
import { logResolvedRuntime, resolveEffectiveProviders } from "./providers.ts";
import { stopSessionsWithin } from "./session-controls.ts";
import { createSessionFactory } from "./session-factory.ts";
import { createRuntimeSessionState } from "./session-state.ts";
import { createSystemPromptResolver } from "./system-prompt.ts";
import { setupTools } from "./tools.ts";
import { createTransportFactory, usesAssemblyS2s } from "./transport.ts";
import type {
  HostRuntime,
  HostRuntimeOptions,
  Runtime,
  RuntimeOptions,
  runtimeBrand,
  SessionStartOptions,
} from "./types.ts";

export type {
  AgentRuntime,
  Runtime,
  RuntimeOptions,
  runtimeBrand,
  SessionStartOptions,
} from "./types.ts";

// ─── Runtime implementation ──────────────────────────────────────────────────

/**
 * Create an agent runtime — the execution engine for a voice agent.
 *
 * Merges built-in and custom tool definitions, builds their tool schemas, and
 * owns per-session transports: pipeline mode (STT → LLM → TTS, the default)
 * or S2S mode when the agent declares an `s2s` descriptor.
 *
 * @param options - Runtime configuration. See {@link RuntimeOptions}.
 * @returns A {@link Runtime} with tool execution, schemas, and session
 *   management.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { createRuntime, type SessionWebSocket } from "@alexkroman1/aai-runtime";
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
export function createRuntime(options: RuntimeOptions): Runtime {
  return createRuntimeWithSeams(options);
}

/**
 * {@link createRuntime} plus the host-only seams of `HostRuntimeOptions`, and
 * the lower-level handles of `HostRuntime` on what it returns. Reached by
 * relative import from this package's own host mode, eval harness and specs;
 * never re-exported.
 *
 * @internal
 */
export function createRuntimeWithSeams(options: HostRuntimeOptions): HostRuntime {
  const {
    agent,
    env,
    createWebSocket,
    createOpenaiRealtimeWebSocket,
    logger = consoleLogger,
    s2sConfig: requestedS2sConfig = DEFAULT_S2S_CONFIG,
    sessionStartTimeoutMs,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  } = options;
  // Providers may come from RuntimeOptions (platform path passes them
  // explicitly) or from the agent's own `stt`/`llm`/`tts` fields (the `aai
  // dev` path calls createRuntime({ agent, env }) with no provider options).
  const effectiveProviders = resolveEffectiveProviders(options, agent);

  const slug = agent.name;
  // Credentials resolve from `providerEnv` (defaults to `env`); `env` alone is
  // what agent tool code sees as `ctx.env`. See RuntimeOptions.providerEnv.
  const providerEnv = options.providerEnv ?? env;
  // Backs slot storage and the workflow journal, NOT anything tool code sees:
  // a caller-injected Db wins (the platform passes one when storage is enabled);
  // otherwise a DATABASE_URL in the provider env (self-hosted `aai dev` reads
  // the project .env) connects one. Neither leaves both stores in memory.
  // The runtime owns — and must close on dispose — only the connection it
  // opened itself; an injected Db stays the caller's to dispose. Without the
  // close, `aai dev` (which rebuilds the runtime on every file save) strands
  // the previous pool on each reload.
  //
  // What it opens is a LEASE on the process's one pool for this URL rather than a
  // pool of its own: the upload store and the wake hint want the same
  // connections, and the app role's `connection limit` is what makes that a
  // requirement rather than a tidiness (see `host/app-db.ts` and
  // `sdk/app-db-budget.ts`). Closing it below stays right — the pool outlives
  // this lease only while somebody else still holds one.
  const ownedDb =
    !options.db && providerEnv.DATABASE_URL ? openAppDb(providerEnv.DATABASE_URL) : undefined;
  const resolvedDb = options.db ?? ownedDb;

  // Validate against the *effective* providers AND mode, not the agent's own
  // fields. Providers may arrive as runtime options rather than on the agent
  // object, and reading `agent` alone once resolved mode "s2s" for every
  // deployed pipeline agent, so every voice tuning knob was refused at session
  // start — a deployed agent listing all three providers died with "holdPhrase
  // requires pipeline mode" — and left `agentConfig.mode` wrong downstream.
  const agentConfig = toAgentConfig({
    ...agent,
    mode: effectiveProviders.agentMode,
    stt: effectiveProviders.stt,
    llm: effectiveProviders.llm,
    tts: effectiveProviders.tts,
    s2s: effectiveProviders.s2s,
  });

  // Per-session slot state, over Postgres when the app has a database and memory
  // otherwise, plus its grace-window sweeps — see `session-state.ts`.
  // The platform's session-state endpoint, when this guest was spawned by one. Read
  // from the same pair the platform world uses, so a deployment cannot end up with
  // durable runs and memory-only turns — or the reverse. `platformGuestOptions`,
  // never `resolvePlatformQueue(providerEnv)`: the platform sets these two keys in
  // the PROCESS's environment, not the agent's (its own doc has the measurement).
  const platformState = platformGuestOptions();
  const sessionState = createRuntimeSessionState({
    db: resolvedDb,
    logger,
    ...omitUndefined({ platform: platformState }),
  });

  // What this runtime resolved, once, at boot — including the WORKFLOW APP case,
  // whose line is deliberately not the pipeline one. See `providers.ts`.
  // Every live session by id — the session, its sink, emitter and meter, and
  // `say`/`announce` — resolved per call, so a resume's takeover is honoured by
  // every reach for the id. `session/directory.ts` is the one place it lives.
  const sessions = createSessionDirectory();
  const { speech } = sessions;
  // Where a `clientTool` call waits for the page's `tool_result`.
  const clientTools = createClientToolBroker();
  // The Voice Agent API accepts exactly one sample rate and honours no declaration
  // to the contrary, so its rates are pinned, not negotiated — BEFORE the ready
  // config is built, because that frame tells the client what to capture and play
  // and the two numbers disagreeing is the whole bug. A host-mode client that asked
  // otherwise was refused at the handshake (`assertHostRatesSupported`).
  const s2sConfig = usesAssemblyS2s(agent)
    ? pinAssemblyS2sRates(requestedS2sConfig, logger)
    : requestedS2sConfig;
  const readyConfig: ReadyConfig = buildReadyConfig(s2sConfig);

  // `ctx.workflows`, built once per runtime rather than per session: a run
  // outlives the session that started it, so nothing about the client is
  // session-scoped. Undefined for an agent that declares none, which is what
  // makes the executor's rejecting stub name the right reason.
  // A caller-supplied client wins, and exactly one has one: an eval, whose
  // bodies were never through the WDK compiler. See `RuntimeOptions.workflows`.
  // `options.journal` reaches the MEMORY arm of the choice below and no other: a
  // runtime rebuilt per save must not rebuild the runs under it.
  const builtWorkflows = options.workflows
    ? undefined
    : buildWorkflowClient(agent, resolvedDb, options.publicUrl, logger, options.journal);
  const workflows = options.workflows ?? builtWorkflows?.client;

  // Watches runs a tool asked to be told about (`start(…, { notify })`) and
  // makes the agent say so — see `workflow/notify.ts`. The session map is the
  // half only this scope has, reached through the speech directory.
  const notifier = buildRunNotifier(workflows, speech.announce, logger);

  const { executeTool, toolSchemas, toolGuidance, pushStateSnapshot, commitSessionState } =
    setupTools({
      agent,
      options,
      ...omitUndefined({ notifier }),
      llm: effectiveProviders.llm,
      env,
      providerEnv,
      workflows,
      logger,
      sessions,
      clientTools,
      stateStore: sessionState.store,
    });

  logResolvedRuntime({
    logger,
    slug,
    mode: agent.mode,
    providers: effectiveProviders,
    sessionState: sessionState.describe,
  });
  // Per runtime, and EAGER only for a voice agent — that module owns the policy.
  const pipelineProviders = createPipelineProviderResolver({
    agent,
    effectiveProviders,
    providerEnv,
  });

  // Transport construction (pipeline, OpenAI Realtime, AssemblyAI S2S) is
  // runtime-transport.ts's, closing over the resolved runtime state above.
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

  // The system prompt, in three parts — the day-cached base, the agent's own
  // instructions when `systemPrompt` is a resolver, and a per-turn suffix. All
  // three, and the reason the expensive part stays cached, are in
  // `system-prompt.ts`.
  const systemPrompts = createSystemPromptResolver({
    agentConfig,
    hasTools: toolSchemas.length > 0 || (agentConfig.builtinTools?.length ?? 0) > 0,
    toolGuidance,
    // `undefined` unless the author declared a RESOLVER, in which case
    // `toAgentConfig` put nothing on the wire for it and this is what fills the
    // agent-specific section per request — see `system-prompt.ts`.
    ...omitUndefined({ instructions: systemPromptResolver(agent.systemPrompt) }),
  });

  const recall = { agent, env, workflows, logger, history: sessionState.history, speech };
  // One session's wiring — controls, transport, core, state and event-log
  // bookends — is `session-factory.ts`'s.
  const createSession = createSessionFactory({
    agent,
    env,
    agentConfig,
    logger,
    sessionState,
    sessions,
    systemPrompts,
    pipelineProviders,
    buildTransport,
    tools: { executeTool, ...omitUndefined({ pushStateSnapshot, commitSessionState }) },
    clientTools,
    relayToolResult: options.onToolResult,
    recall,
  });

  // ── AgentRuntime methods ──────────────────────────────────────────────

  function startSession(ws: SessionWebSocket, startOpts?: SessionStartOptions): void {
    const { resumeFrom, clientLocation, clientId, clientPhone, call } = startOpts ?? {};
    const userOnSessionEnd = startOpts?.onSessionEnd;
    wireSessionSocket(ws, {
      sessions,
      createSession: (sid, client) =>
        createSession({
          id: sid,
          agent: agent.name,
          client,
          skipGreeting: startOpts?.skipGreeting ?? false,
          // A resume is what makes a history restore worth a round trip, and the
          // socket's own `?sessionId=` is the honest signal — inferring it from a
          // stored count would read a crashed-and-reconnected session the same as
          // a fresh one whose id happened to collide.
          resumed: resumeFrom !== undefined,
        }),
      readyConfig,
      logger,
      ...omitUndefined({ logContext: startOpts?.logContext, audioLeadMs: startOpts?.audioLeadMs }),
      ...omitUndefined({ onOpen: startOpts?.onOpen, onClose: startOpts?.onClose }),
      ...omitUndefined({ onSinkCreated: startOpts?.onSinkCreated }),
      // sinkMap/session-state cleanup lives in the identity-guarded stop() wrapper
      // (createSession) — a key delete here would hit the resumed session's
      // entries when an old session's stop settles after a reconnect.
      onSessionEnd: (sid, sink) => {
        userOnSessionEnd?.(sid, sink);
      },
      ...omitUndefined({ sessionStartTimeoutMs, resumeFrom }),
      ...omitUndefined({ clientLocation, clientId, clientPhone, call }),
    });
  }

  function releaseResources(): void {
    sessions.clear();
    // Watches outlive nothing: every session they could announce to is gone,
    // and a poll loop left running would hold the process past shutdown.
    notifier?.stop();
    // The workflow engine's pending deliveries, for the same reason: a rebuilt
    // runtime would otherwise leave the previous engine's timers executing
    // bodies from a build that is gone. Only an engine THIS runtime built —
    // a caller-supplied `options.workflows` is the caller's to stop.
    builtWorkflows?.stop();
    // Force-close on timeout skips the per-session stop wrapper's state cleanup
    // (its sink-identity check fails against the cleared map), so clear the cache
    // here too or timed-out sessions leak their slot values permanently. Only the
    // CACHE: a stored row still belongs to a session that may yet resume onto a
    // replacement process, which is the whole point of storing it.
    sessionState.store.clear();
    // Same reasoning for the event log's in-process half: the pending batch of a
    // force-closed session is unrecoverable either way, and holding the entries
    // would leak one per session past shutdown.
    sessionState.stream.clear();
    // Pending grace-window sweeps have nothing left to reclaim.
    sessionState.sweeps.clear();
    sessionState.unpublish();
    // Release a runtime-owned DB pool (see the resolution comment above).
    // Fire-and-forget: releaseResources is sync and a drain failure on a
    // dying pool is not actionable.
    void ownedDb?.close().catch(() => undefined);
  }

  async function shutdown(): Promise<void> {
    await stopSessionsWithin(sessions, shutdownTimeoutMs, logger);
    releaseResources();
  }

  // Built WITHOUT the seal and cast once: the brand is type-only (see
  // `runtimeBrand`), which is what makes this the one place a `Runtime` exists.
  const runtime = {
    executeTool,
    toolSchemas,
    createSession,
    startSession,
    shutdown,
    readyConfig,
    // The event log, exposed for the reason `workflows` below is: a surface outside
    // the runtime serves reads of it (`GET /session-events/:id`), and one stream per
    // runtime is what makes an index mean the same thing to every reader.
    sessionEvents: sessionState.stream,
    // Exposed rather than kept private because tool code is not the only caller:
    // `createRuntimeServer` serves the workflow HTTP API from exactly this client, so a
    // page and a `curl` reach the same runs a tool does. One client per runtime,
    // not one per surface — two would index correlation keys separately.
    workflows,
    // The DELIVERY hook, separate from the client on purpose — see its own doc on
    // `AgentRuntime`. Present only when THIS runtime built the engine: a caller
    // that supplied its own `workflows` client supplied a client and not an
    // engine, so there is nothing here to re-walk a run with, and answering a
    // delivery from someone else's client would be a guess.
    deliverWorkflow: builtWorkflows?.execute,
    // `agent({ routes })`, compiled once — a bad key fails HERE. See `agent-routes.ts`.
    serveRoute: compileAgentRoutes({ ...recall, routes: agent.routes }),
  } satisfies Omit<HostRuntime, typeof runtimeBrand> as HostRuntime;
  registerConnector(runtime, {
    sessions,
    readyConfig,
    logger,
    sessionStartTimeoutMs,
    createSession: (id, client, o) => createSession({ id, agent: agent.name, client, ...o }),
  });
  return runtime;
}
