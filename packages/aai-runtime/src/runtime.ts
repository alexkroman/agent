// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent runtime — the execution engine for voice agents.
 *
 * {@link createRuntime} builds the single execution engine used by both
 * self-hosted servers and the platform sandbox. It wires up tool execution,
 * lifecycle hooks, and session management.
 */

import {
  buildSystemPrompt,
  createOwnedMap,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from "@alexkroman1/aai/host-internal";
import { invariant } from "@alexkroman1/aai/internal";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import type { ClientSink } from "@alexkroman1/aai/protocol";
import { buildReadyConfig, type ReadyConfig } from "@alexkroman1/aai/protocol";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import pTimeout, { TimeoutError } from "p-timeout";
import { openAppDb } from "./app-db.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG, pinAssemblyS2sRates } from "./runtime-config.ts";
import { createPipelineProviderResolver } from "./runtime-pipeline-providers.ts";
import { logResolvedRuntime, resolveEffectiveProviders } from "./runtime-providers.ts";
import { buildSessionCallbacks } from "./runtime-session-callbacks.ts";
import { attachSessionState, createRuntimeSessionState } from "./runtime-session-state.ts";
import { attachSessionStream } from "./runtime-session-stream.ts";
import { setupTools } from "./runtime-tools.ts";
import {
  createTransportFactory,
  type TransportSessionOpts,
  usesAssemblyS2s,
} from "./runtime-transport.ts";
import type { Runtime, RuntimeOptions, SessionStartOptions } from "./runtime-types.ts";
import { createSessionCore, type ServerSession } from "./session-core.ts";
import { createSessionEmitter, hookDepsFor, type SessionEmitter } from "./session-emitter.ts";
import { createResumeFindings, resolveSkipGreeting } from "./session-resume-found.ts";
import { platformGuestOptions } from "./workflow-platform-world.ts";
import { buildRunNotifier, buildWorkflowClient } from "./workflow-runtime.ts";
import { type SessionWebSocket, wireSessionSocket } from "./ws-handler.ts";

export type {
  AgentRuntime,
  Runtime,
  RuntimeOptions,
  SessionStartOptions,
} from "./runtime-types.ts";

// ─── Runtime implementation ──────────────────────────────────────────────────

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
  //
  // What it opens is a LEASE on the process's one pool for this URL rather than a
  // pool of its own: the upload store and the wake hint want the same
  // connections, and the app role's `connection limit` is what makes that a
  // requirement rather than a tidiness (see `host/app-db.ts` and
  // `sdk/app-db-budget.ts`). Closing it below stays right — the pool outlives
  // this lease only while somebody else still holds one.
  const ownedDb =
    !opts.db && providerEnv.DATABASE_URL ? openAppDb(providerEnv.DATABASE_URL) : undefined;
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

  // Per-session slot state, over Postgres when the app has a database and memory
  // otherwise, plus its grace-window sweeps — see `runtime-session-state.ts`.
  // It REPLACES the `Map` this used to be.
  // The platform's session-state endpoint, when this guest was spawned by one. Read
  // from the same pair the platform world uses, so a deployment cannot end up with
  // durable runs and memory-only turns — or the reverse.
  //
  // `platformGuestOptions`, never `resolvePlatformQueue(providerEnv)`: that is the
  // AGENT's environment and the platform puts these two keys in the PROCESS's, so
  // the line above described an invariant it was breaking. Every deployed agent
  // ran on the memory backend. Its own doc has the measurement.
  const platformState = platformGuestOptions();
  const sessionState = createRuntimeSessionState({
    db: resolvedDb,
    logger,
    ...omitUndefined({ platform: platformState }),
  });

  // What this runtime resolved, once, at boot — including the WORKFLOW APP case,
  // whose line is deliberately not the pipeline one. See `runtime-providers.ts`.
  logResolvedRuntime({
    logger,
    slug,
    page: agent.page,
    providers: effectiveProviders,
    sessionState: sessionState.describe,
  });
  // Owned maps because teardown is async on both: a reconnect resuming the
  // same session id re-claims the key while the old session's stop() drains,
  // and release-by-claim is what keeps that drain from evicting the
  // successor's entry (see sdk/owned-map.ts).
  const sessions = createOwnedMap<string, ServerSession>();
  const sinkMap = createOwnedMap<string, ClientSink>();
  // What `ctx.send` and a `syncState` push resolve through, for the same resume
  // reason as the sink map beside it — see `liveEmitter` in `runtime-tools.ts`.
  const emitters = createOwnedMap<string, SessionEmitter>();
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

  // `ctx.workflows`, built once per runtime rather than per session: a run
  // outlives the session that started it, so nothing about the client is
  // session-scoped. Undefined for an agent that declares none, which is what
  // makes the executor's rejecting stub name the right reason.
  // A caller-supplied client wins, and exactly one has one: an eval, whose
  // bodies were never through the WDK compiler. See `RuntimeOptions.workflows`.
  // `opts.journal` reaches the MEMORY arm of the choice below and no other: a
  // runtime rebuilt per save must not rebuild the runs under it.
  const builtWorkflows = opts.workflows
    ? undefined
    : buildWorkflowClient(agent, resolvedDb, opts.publicUrl, logger, opts.journal);
  const workflows = opts.workflows ?? builtWorkflows?.client;

  // Watches runs a tool asked to be told about (`start(…, { notify })`) and
  // makes the agent say so — see `workflow-notify.ts`. The session map is the
  // half only this scope has.
  const notifier = buildRunNotifier(
    workflows,
    (sid, text) => sessions.get(sid)?.announce(text) ?? false,
    logger,
  );

  const { executeTool, toolSchemas, toolGuidance, pushStateSnapshot, commitSessionState } =
    setupTools({
      agent,
      opts,
      ...omitUndefined({ notifier }),
      llm: effectiveProviders.llm,
      env,
      providerEnv,
      workflows,
      logger,
      emitters,
      stateStore: sessionState.store,
    });

  // Resolved once per runtime, and resolved EAGERLY only for a voice agent —
  // see `runtime-pipeline-providers.ts`, which owns that policy and why a
  // workflow app must not pay it.
  const pipelineProviders = createPipelineProviderResolver({
    agent,
    effectiveProviders,
    providerEnv,
  });

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

  function createSession(sessionOpts: TransportSessionOpts): ServerSession {
    // A resume under this id (same key, new socket) reclaims its tool state —
    // cancel the sweep the previous session's stop() scheduled.
    sessionState.sweeps.cancel(sessionOpts.id);
    const releaseSink = sinkMap.claim(sessionOpts.id, sessionOpts.client);

    // The one way this session publishes an event: recorded into the retained
    // stream, sent to the client, then announced to the agent's own hooks. Built
    // BEFORE the transport callbacks, because two of them emit directly. The
    // storage message is the SAME constant a tool's `ctx.db` throws — an audit
    // hook and a tool hit one condition, so they must not describe it two ways.
    const hooks = hookDepsFor({
      handlers: agent.events,
      env,
      // The same view a tool call's `ctx.slots` is, so a hook and a tool that
      // touch one slot are touching one value rather than two caches of it.
      slots: sessionState.store.viewFor(sessionOpts.id),
    });
    // Fire-and-forget: `commitSessionState` never rejects, and the emit path is
    // synchronous — a hook's write must not put a backend round trip in front of
    // the next frame on a live call.
    const commit = commitSessionState
      ? (): void => void commitSessionState(sessionOpts.id)
      : undefined;
    const emitter = createSessionEmitter({
      sessionId: sessionOpts.id,
      client: sessionOpts.client,
      stream: sessionState.stream,
      logger,
      ...omitUndefined({ hooks, commit }),
    });
    const releaseEmitter = emitters.claim(sessionOpts.id, emitter);

    // Call it — `pipelineProviders` is a thunk (see above), so `Boolean(...)` on
    // the function itself is always true and would route every S2S session down
    // the pipeline branch. By here a session is being created, so resolving is
    // exactly what a static agent's deferral was waiting for.
    const isPipeline = pipelineProviders() !== null;
    // Relay (host) mode: the relay `executeTool` emits the client-facing
    // `tool.called` itself (mirrors the `relayed` flag session-core passes on).
    const isRelay = Boolean(opts.onToolResult);
    const systemPrompt = systemPromptForToday();

    // Late-bound reference: callbacks are constructed before ServerSession exists,
    // so we capture a reference and fill it in below.
    let core: ServerSession | null = null;
    function bindCore(): ServerSession {
      // An invariant rather than a validation: `core` is this closure's own
      // local, filled in below and readable by nobody else, so a null here is a
      // mis-ordering in THIS function and never anything a caller did.
      invariant(core !== null, "session.core.bound");
      return core;
    }

    // Everything a transport calls back into, including the one callback with
    // three different right answers — see `runtime-session-callbacks.ts`.
    const callbacks = buildSessionCallbacks({ bindCore, emitter, isPipeline, isRelay });

    // What this resume recovered, written by the two lookups below and read by
    // the greeting — it must exist BEFORE the transport; `session-resume-found.ts`
    // carries why, and owns the decision `skipGreeting` becomes.
    const findings = createResumeFindings();
    const { skipGreeting, resumed } = sessionOpts;
    const transport = buildTransport({
      sessionOpts: {
        ...sessionOpts,
        skipGreeting: resolveSkipGreeting(skipGreeting, resumed, findings),
      },
      systemPrompt,
      callbacks,
    });

    core = createSessionCore({
      id: sessionOpts.id,
      agent: sessionOpts.agent,
      client: sessionOpts.client,
      emitter,
      agentConfig,
      executeTool,
      transport,
      logger,
      ...omitUndefined({ onToolResult: opts.onToolResult }),
    });

    // Hydration on the way in, reclamation on the way out — see
    // `attachSessionState`, which owns both orderings and why they are here
    // rather than in `ws-handler`.
    attachSessionState(core, {
      state: sessionState,
      sessionId: sessionOpts.id,
      emitter,
      // Both claims come off together: they are one session's hold on one id, and
      // releasing only the sink would leave a `ctx.send` from a straggling tool
      // call resolving an emitter whose socket is gone.
      release: () => {
        const owned = releaseSink();
        releaseEmitter();
        return owned;
      },
      pushStateSnapshot,
      findings,
    });

    // The event log's own bookends: continue it on the way in (and restore the
    // conversation from it on a resume), write out the batch on the way out. A
    // separate wrapper from the state one because they are separate lifetimes —
    // see `runtime-session-stream.ts`.
    attachSessionStream(core, {
      stream: sessionState.stream,
      sessionId: sessionOpts.id,
      resumed: sessionOpts.resumed === true,
      findings,
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
          // A resume is what makes a history restore worth a round trip, and the
          // socket's own `?sessionId=` is the honest signal — inferring it from a
          // stored count would read a crashed-and-reconnected session the same as
          // a fresh one whose id happened to collide.
          resumed: resumeFrom !== undefined,
        }),
      readyConfig,
      logger,
      ...omitUndefined({ logContext: startOpts?.logContext }),
      ...omitUndefined({ onOpen: startOpts?.onOpen }),
      ...omitUndefined({ onClose: startOpts?.onClose }),
      ...omitUndefined({ onSinkCreated: startOpts?.onSinkCreated }),
      ...omitUndefined({ audioLeadMs: startOpts?.audioLeadMs }),
      // sinkMap/session-state cleanup lives in the identity-guarded stop() wrapper
      // (createSession) — a key delete here would hit the resumed session's
      // entries when an old session's stop settles after a reconnect.
      onSessionEnd: (sid, sink) => {
        userOnSessionEnd?.(sid, sink);
      },
      ...omitUndefined({ sessionStartTimeoutMs, resumeFrom }),
    });
  }

  function releaseResources(): void {
    sessions.clear();
    sinkMap.clear();
    emitters.clear();
    // Watches outlive nothing: every session they could announce to is gone,
    // and a poll loop left running would hold the process past shutdown.
    notifier?.stop();
    // The workflow engine's pending deliveries, for the same reason: a rebuilt
    // runtime would otherwise leave the previous engine's timers executing
    // bodies from a build that is gone. Only an engine THIS runtime built —
    // a caller-supplied `opts.workflows` is the caller's to stop.
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
    // The event log, exposed for the same reason `workflows` below is: a surface
    // outside the runtime serves reads of it (`GET /session-events/:id`), and one
    // stream per runtime is what makes an index mean the same thing to every
    // reader.
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
  };
}
