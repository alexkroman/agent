// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool-surface assembly for the agent runtime.
 *
 * {@link setupTools} builds the runtime's tool dispatcher, schemas, and LLM
 * guidance for both execution modes — RPC-backed sandbox mode (platform)
 * and in-process self-hosted mode.
 */

import { agentToolsToSchemas, type ToolSchema } from "../sdk/_internal-types.ts";
import { serializeToolFailure } from "../sdk/_tool-failure-wire.ts";
import {
  DEFAULT_BUILTIN_TOOLS,
  MAX_CLIENT_EVENT_NAME_LENGTH,
  MAX_CLIENT_EVENT_PAYLOAD_BYTES,
} from "../sdk/constants.ts";
import type { Db } from "../sdk/db.ts";
import type { AgentEnv, ProviderEnv } from "../sdk/env-types.ts";
import type { OwnedMap } from "../sdk/owned-map.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import type { LlmProvider } from "../sdk/providers.ts";
import type { AgentDef, ToolDef } from "../sdk/types.ts";
import type { StartOptions, WorkflowClient } from "../sdk/workflow.ts";
import { createStateSync } from "./_state-sync.ts";
import { resolveAllBuiltins, SANDBOX_ONLY_BUILTINS } from "./builtin-tools.ts";
import { createGenerateFn, type HostGenerateFn } from "./generate.ts";
import type { RuntimeOptions } from "./runtime-types.ts";
import { type ExecuteTool, executeToolCall } from "./tool-executor.ts";
import type { RunNotifier } from "./workflow-notify.ts";

/**
 * Merge the agent's builtins with the tools a mode dispatches itself — the
 * single owner of the collision policy for every tool path — sandbox/relay,
 * self-hosted, and {@link createTextAgent}. A provided tool with the same name as a builtin wins,
 * and the colliding builtin is dropped from both dispatch and schemas so the
 * host never shadows a tool the caller expects to execute and the LLM never
 * sees a duplicate name. Provided schemas/guidance come first, builtins after.
 */
export function mergeBuiltinSurface(
  agent: AgentDef,
  builtinOpts: Parameters<typeof resolveAllBuiltins>[1],
  provided: { schemas: ToolSchema[]; guidance?: string[] },
): {
  defs: Record<string, ToolDef>;
  schemas: ToolSchema[];
  guidance: string[];
} {
  const providedNames = new Set(provided.schemas.map((s) => s.name));
  const names = (agent.builtinTools ?? DEFAULT_BUILTIN_TOOLS).filter(
    (name) => !providedNames.has(name),
  );
  const builtins = resolveAllBuiltins(names, builtinOpts);
  return {
    defs: builtins.defs,
    schemas: [...provided.schemas, ...builtins.schemas],
    guidance: [...(provided.guidance ?? []), ...builtins.guidance],
  };
}

/** The runtime's resolved tool surface: dispatcher, schemas, and LLM guidance. */
type ToolSetup = {
  executeTool: ExecuteTool;
  toolSchemas: ToolSchema[];
  toolGuidance: string[];
  /**
   * Send the current `syncState` projection to a client that just connected.
   *
   * Only meaningful on RESUME. A session's state survives a disconnect
   * through the grace window, so a reconnecting browser is looking at a live
   * cart it cannot see — nothing would push again until the next tool call,
   * and there may not be one. Absent on the sandbox path, where the runtime
   * holds no state.
   */
  pushStateSnapshot?: (sessionId: string, sink: ClientSink) => void;
};

/** Runtime state the tool-setup paths close over. */
type ToolSetupDeps = {
  agent: AgentDef;
  opts: RuntimeOptions;
  /**
   * The agent's EFFECTIVE LLM descriptor, already resolved by
   * `resolveEffectiveProviders` in runtime.ts — the one owner of the
   * option-vs-agent-field precedence. Passed in rather than re-derived here
   * so ctx.generate can never resolve a different provider than the
   * pipeline runs on.
   */
  llm: LlmProvider | undefined;
  /** Becomes `ctx.env` (frozen) — agent-owned only, see sdk/env-types.ts. */
  env: AgentEnv;
  providerEnv: ProviderEnv;
  /** ctx.db when storage is enabled; undefined makes ctx.db access throw. */
  resolvedDb: Db | undefined;
  /**
   * `ctx.workflows`. Undefined when the agent declares no workflows, and the
   * executor substitutes a client that rejects naming the reason — so this is
   * "does this agent have workflows", not "is the option set".
   */
  workflows: WorkflowClient | undefined;
  /**
   * Watches runs a tool asked to be told about — `start(…, { notify })`.
   *
   * Absent for an agent with no workflows, and absent is what makes `notify` a
   * silent no-op rather than a failure: the option describes what should happen
   * WHEN a run lands, and an agent that cannot start one never lands any.
   */
  notifier?: RunNotifier | undefined;
  logger: NonNullable<RuntimeOptions["logger"]>;
  sinkMap: OwnedMap<string, ClientSink>;
  /** Per-session tool state (self-hosted mode only); cleaned up on session end. */
  stateMap: Map<string, Record<string, unknown>>;
};

/**
 * `ctx.workflows` for ONE session: the runtime's client, with `notify` wired.
 *
 * The client itself is per-RUNTIME and rightly so — a run outlives the session
 * that started it, so nothing about reading one is session-scoped. What IS
 * session-scoped is who gets told: `notify` means "tell the caller on THIS
 * call", so the session id has to be captured where it is known, which is here
 * and nowhere deeper.
 *
 * Returns the client UNCHANGED when there is no notifier or no session id, so
 * the wrapper costs nothing for the agents that never use it.
 */
function withNotify(
  workflows: WorkflowClient | undefined,
  notifier: RunNotifier | undefined,
  sessionId: string | undefined,
): WorkflowClient | undefined {
  if (!(workflows && notifier && sessionId)) return workflows;
  // The overload is preserved by delegating with the arguments as given —
  // `start` takes a definition or a name, and the watcher needs neither: the
  // run it polls reports its own declared name.
  const start = (async (workflow: never, input: never, options?: StartOptions): Promise<string> => {
    const runId = await workflows.start(workflow, input, options);
    if (options?.notify !== undefined && options.notify !== false) {
      notifier.watch({
        sessionId,
        runId,
        // `true` takes the default instruction; a string replaces it.
        ...(typeof options.notify === "string" ? { instruction: options.notify } : {}),
      });
    }
    return runId;
  }) as WorkflowClient["start"];
  return { ...workflows, start };
}

/**
 * Build the ctx.generate implementation for this runtime: the agent's
 * effective LLM descriptor with credentials from `providerEnv`.
 */
function setupGenerate(deps: ToolSetupDeps): HostGenerateFn {
  return createGenerateFn({
    llm: deps.llm,
    env: deps.providerEnv,
  });
}

/** Sandbox mode — custom tools are RPC-backed; builtins run host-side. */
function setupSandboxTools(deps: ToolSetupDeps, rpcExecuteTool: ExecuteTool): ToolSetup {
  const { agent, opts, env, resolvedDb, workflows, notifier, logger } = deps;
  const builtinFetchOpt = opts.fetch ? { fetch: opts.fetch } : undefined;
  const generate = setupGenerate(deps);
  const resolved = mergeBuiltinSurface(agent, builtinFetchOpt, {
    schemas: opts.toolSchemas ?? [],
    ...(opts.toolGuidance ? { guidance: opts.toolGuidance } : {}),
  });
  const builtinDefs = resolved.defs;
  const toolSchemas = resolved.schemas;
  const frozenEnv = Object.freeze({ ...env });

  const executeTool: ExecuteTool = async (name, args, sessionId, messages, callOpts) => {
    // Handle builtins on the host (where SSRF-safe fetch lives) — EXCEPT
    // sandbox-only builtins (see SANDBOX_ONLY_BUILTINS), which execute
    // untrusted JS and must run inside the guest sandbox (Modal/Deno),
    // never on the host. They are delegated via RPC like custom tools;
    // the guest harness runs them directly.
    if (builtinDefs[name] && !SANDBOX_ONLY_BUILTINS.has(name)) {
      const tool = builtinDefs[name];
      return executeToolCall(name, args, {
        tool,
        env: frozenEnv,
        sessionId: sessionId ?? "",
        db: resolvedDb,
        workflows: withNotify(workflows, notifier, sessionId),
        messages,
        generate,
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
  return { executeTool, toolSchemas, toolGuidance: resolved.guidance };
}

/**
 * Self-hosted mode — in-process tool execution. A custom tool with the
 * same name as a builtin wins: the builtin is dropped from both dispatch
 * and schemas rather than emitting a duplicate schema name to the LLM.
 */
function setupSelfHostedTools(deps: ToolSetupDeps): ToolSetup {
  const { agent, opts, env, resolvedDb, workflows, notifier, logger, sinkMap, stateMap } = deps;
  const builtinOpts = {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    // The guest harness runs this path INSIDE the sandbox and provides the
    // real run_code executor; without one the builtin refuses (aai dev).
    ...(opts.runCode ? { runCode: opts.runCode } : {}),
  };
  const customSchemas = agentToolsToSchemas(agent.tools ?? {});
  const builtins = mergeBuiltinSurface(agent, builtinOpts, { schemas: customSchemas });
  const allTools: Record<string, AgentDef["tools"][string]> = {
    ...builtins.defs,
    ...agent.tools,
  };
  const toolSchemas = builtins.schemas;

  // Deliberately NOT `stateMap.getOrInsertComputed(sid, ...)`, which is the
  // obvious fit. `Map.prototype.getOrInsert{,Computed}` is V8 14.6 — Node 26 —
  // while this package publishes `engines.node: ">=24"` so SDK consumers on
  // the previous LTS keep working. `lib: ["ESNext"]` types it either way, so
  // tsc is no guard at all here: it type-checks, ships, and throws
  // `not a function` on the consumer's Node 24. The V8 14.6 additions are
  // usable in the platform packages (aai-server, aai-guest, aai-studio-*,
  // all `>=26`) and not in this one.
  /**
   * The session's ONE state object — memoized whether or not the agent
   * declared a `state` factory.
   *
   * The `?? {}` this replaces only looked like a default. With no factory
   * nothing was ever stored, so every read minted a FRESH `{}`: a tool wrote
   * `ctx.state.cart = []`, the write succeeded, and the next call — or the
   * `syncStateToClient` in the same call's `finally`, which calls this a
   * second time — saw an empty object again. Silent in exactly the way that
   * costs the most: no throw, no log, and `AgentDef.state`'s own doc promises
   * the opposite ("unset leaves `ctx.state` an empty object", one of them).
   * Four of the five shipped templates hit it — `infocom-adventure`,
   * `solo-rpg`, `dispatch-center` and `pizza-ordering` all mutate `ctx.state`
   * through a `slot.x ??= …` helper and declare no factory, so the adventure
   * game reset its room and inventory on every tool call and `syncState`
   * projected an empty object to the client.
   *
   * `stateMap.has(sid)` keeps meaning "this session has run a tool call",
   * which is what `pushStateSnapshot` reads it for, and the entry is reclaimed
   * by the same grace-window sweep (`session-state-sweeps.ts`) either way.
   */
  const getState = (sid: string): Record<string, unknown> => {
    const existing = stateMap.get(sid);
    if (existing !== undefined) return existing;
    const created = agent.state ? agent.state() : {};
    stateMap.set(sid, created);
    return created;
  };
  const frozenEnv = Object.freeze({ ...env });

  const generate = setupGenerate(deps);

  /**
   * `ctx.send` → client `custom_event`, with the wire caps enforced here —
   * this is the single point where a tool's send becomes a client frame now
   * that the runtime runs in-guest (the old guest→host `client/send` relay,
   * which held these checks, is gone). Over-cap events are dropped, matching
   * that relay: the name cap mirrors the protocol schema, and the payload is
   * measured in UTF-8 bytes (what actually crosses the socket).
   */
  const sendToClient = (sink: ClientSink, event: string, data: unknown): void => {
    if (event.length > MAX_CLIENT_EVENT_NAME_LENGTH) return;
    if (Buffer.byteLength(JSON.stringify(data ?? null)) > MAX_CLIENT_EVENT_PAYLOAD_BYTES) return;
    sink.event({ type: "custom_event", event, data });
  };

  /**
   * Push the agent's projected state to the client when it changed. The
   * decision (project, compare, cap) lives in `_state-sync.ts`; this is the
   * wiring and the logging.
   */
  const stateSync = agent.syncState ? createStateSync(agent.syncState) : undefined;
  const syncStateToClient = (
    sink: ClientSink | undefined,
    state: object,
    options?: { force?: boolean },
  ): void => {
    if (!(sink && stateSync)) return;
    const result = stateSync(state, options);
    if (result.push) {
      sink.event({ type: "agent_state", state: result.state });
      return;
    }
    if (result.reason === "failed") {
      logger?.warn?.(`syncState projection failed: ${result.detail}`);
    } else if (result.reason === "too-large") {
      logger?.warn?.(`syncState projection is ${result.bytes} bytes; not sent`);
    }
  };

  const executeTool: ExecuteTool = async (name, args, sessionId, messages, callOpts) => {
    const tool = allTools[name];
    if (!tool) return serializeToolFailure(`Unknown tool: ${name}`);
    const sid = sessionId ?? "";
    /**
     * Resolved per send, never captured at dispatch. A tool call routinely
     * outlives the socket that issued it (it may run for the whole tool
     * timeout, and a session survives a disconnect through the resume grace
     * window), so by the time it sends, `sinkMap` may hold the RESUMED
     * connection's sink under the same id — captured, both sends below went
     * to the superseded socket instead. For `syncState` that is worse than a
     * dropped frame: the push records the projection as delivered
     * (`lastSent` in _state-sync.ts, keyed by the state object the resume
     * shares), so the next unchanged projection is skipped and the
     * reconnected client stays stale with no further push coming.
     */
    const liveSink = (): ClientSink | undefined => sinkMap.get(sid);
    const run = () =>
      executeToolCall(name, args, {
        tool,
        env: frozenEnv,
        state: getState(sid),
        sessionId: sid,
        // db traffic is a TCP socket, not fetch, so the egress guard never
        // sees it — no exemption wrapper needed.
        db: resolvedDb,
        workflows: withNotify(workflows, notifier, sid),
        messages,
        generate,
        logger,
        // Always defined: `ctx.send` is a no-op when no socket holds the id
        // (the same shape a missing sink produced before), and binding it
        // late is what lets a resumed client receive it.
        send: (event, data) => {
          const sink = liveSink();
          if (sink) sendToClient(sink, event, data);
        },
        // Turn cancellation (barge-in/reset/stop) unblocks the tool await.
        signal: callOpts?.signal,
      });
    try {
      return await run();
    } finally {
      // In `finally` so a throwing tool still publishes what it changed
      // before it failed — a half-applied mutation the UI is not showing is
      // worse than one it is.
      syncStateToClient(liveSink(), getState(sid));
    }
  };
  /**
   * Forced, and only for a session that ALREADY has state — i.e. a resume.
   * A brand-new session has nothing to show, and calling `getState` here
   * would run the agent's `state()` factory at connect time rather than at
   * the first tool call, which is a semantic change nobody asked for.
   */
  const pushStateSnapshot = (sessionId: string, sink: ClientSink): void => {
    if (!(stateSync && stateMap.has(sessionId))) return;
    syncStateToClient(sink, getState(sessionId), { force: true });
  };

  return { executeTool, toolSchemas, toolGuidance: builtins.guidance, pushStateSnapshot };
}

/** Pick the tool path: RPC-backed sandbox mode when overrides are provided. */
export function setupTools(deps: ToolSetupDeps): ToolSetup {
  const { executeTool, toolSchemas } = deps.opts;
  return executeTool && toolSchemas
    ? setupSandboxTools(deps, executeTool)
    : setupSelfHostedTools(deps);
}
