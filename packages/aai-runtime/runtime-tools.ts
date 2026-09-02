// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool-surface assembly for the agent runtime.
 *
 * {@link setupTools} builds the runtime's tool dispatcher, schemas, and LLM
 * guidance for both execution modes — RPC-backed sandbox mode (platform)
 * and in-process self-hosted mode.
 */

import type { AgentDef, StateProjection, ToolDef } from "@alexkroman1/aai";
import type { AgentEnv, OwnedMap, ProviderEnv } from "@alexkroman1/aai/host-internal";
import { resolveAllBuiltins, SANDBOX_ONLY_BUILTINS } from "@alexkroman1/aai/host-internal";
import {
  clientEventDropMessage,
  DEFAULT_BUILTIN_TOOLS,
  decideClientEvent,
} from "@alexkroman1/aai/internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { agentToolsToSchemas, type ToolSchema } from "@alexkroman1/aai/manifest";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { StartOptions, WorkflowClient } from "@alexkroman1/aai/workflow-api";
import { createStateSync } from "./_state-sync.ts";
import { createGenerateFn, type HostGenerateFn } from "./generate.ts";
import type { Logger } from "./runtime-config.ts";
import type { RuntimeOptions } from "./runtime-types.ts";
import type { SessionEmitter } from "./session-emitter.ts";
import type { SessionStateStore } from "./session-state-store.ts";
import { createSubagentRunner } from "./subagent.ts";
import {
  createToolDispatcher,
  type ExecuteTool,
  executeToolCall,
  type SubagentRunner,
} from "./tool-executor.ts";
import type { RunNotifier } from "./workflow-notify.ts";

/**
 * Merge the agent's builtins with the tools a mode dispatches itself — the
 * single owner of the collision policy for every tool path — sandbox/relay,
 * self-hosted, and {@link createTextAgent}. A provided tool with the same name as a builtin wins,
 * and the colliding builtin is dropped from both dispatch and schemas so the
 * host never shadows a tool the caller expects to execute and the LLM never
 * sees a duplicate name. Provided schemas/guidance come first, builtins after.
 *
 * **A dropped builtin is LOGGED**, because the author declared it. `tools/
 * web_search.ts` beside `builtinTools: ["web_search"]` is one of two things — a
 * deliberate replacement, or a file whose name collided by accident — and
 * nothing anywhere said which had happened: the entry in `builtinTools` simply
 * did nothing, and an author debugging "why is my search not the built-in one"
 * (or the reverse) had no thread to pull. The policy itself is unchanged; the
 * file still wins.
 */
export function mergeBuiltinSurface(
  agent: AgentDef,
  builtinOpts: Parameters<typeof resolveAllBuiltins>[1],
  provided: { schemas: ToolSchema[]; guidance?: string[] },
  logger?: Logger | undefined,
): {
  defs: Record<string, ToolDef>;
  schemas: ToolSchema[];
  guidance: string[];
} {
  const providedNames = new Set(provided.schemas.map((s) => s.name));
  const declared = agent.builtinTools ?? DEFAULT_BUILTIN_TOOLS;
  const names = declared.filter((name) => !providedNames.has(name));
  const shadowed = declared.filter((name) => providedNames.has(name));
  if (shadowed.length > 0) {
    logger?.info?.(
      `builtinTools ${shadowed.map((name) => `"${name}"`).join(", ")} ${shadowed.length === 1 ? "is" : "are"} inert: a tools/ file of the same name is what the model will call. Rename the file if that was not the intent.`,
    );
  }
  const builtins = resolveAllBuiltins(names, builtinOpts);
  return {
    defs: builtins.defs,
    schemas: [...provided.schemas, ...builtins.schemas],
    guidance: [...(provided.guidance ?? []), ...builtins.guidance],
  };
}

/**
 * `agent.syncState` as a list, since it takes one projection or several.
 *
 * One is overwhelmingly the common case — every stateful template projects a
 * single slot — so the singular form is what an author writes and the array is
 * what an agent with two slots reaches for.
 */
function toProjectionList(syncState: AgentDef["syncState"]): readonly StateProjection[] {
  if (!syncState) return [];
  // `Array.isArray` narrows the ARRAY arm and leaves the other one as the whole
  // union (a `StateProjection` is callable, not an array, but the check's
  // type predicate is `unknown[]` and says nothing about the negative case), so
  // the singular arm is read off a flattened copy rather than asserted.
  return [syncState].flat();
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
  pushStateSnapshot?: (sessionId: string, emitter: SessionEmitter) => void;
  /**
   * Publish and store what a SESSION EVENT HOOK wrote.
   *
   * The same pair the tool executor runs in its own `finally` — push the
   * projection, then flush — exposed because a hook has no tool call around it
   * and so no other commit point. Absent on the sandbox path for the same reason
   * `pushStateSnapshot` is: the runtime holds no state there.
   */
  commitSessionState?: (sessionId: string) => Promise<void>;
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
  /**
   * Live EMITTER per session, so `ctx.send` and a `syncState` push are recorded
   * in the session's event stream and seen by its hooks like any other event —
   * they used to write straight to a `ClientSink`, which made them the two events
   * no log could contain and no hook could observe.
   *
   * Still a map rather than one emitter, and still resolved per send, for the
   * resume reason spelled out at `liveEmitter`.
   */
  emitters: OwnedMap<string, SessionEmitter>;
  /**
   * Per-session slot state (self-hosted mode only), over the memory or Postgres
   * backend — see `host/session-state-store.ts`. Reclaimed after the resume
   * grace window by `session-state-sweeps.ts`.
   */
  stateStore: SessionStateStore;
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
  // A caller-supplied one wins — see `RuntimeOptions.generate`.
  return (
    deps.opts.generate ??
    createGenerateFn({
      llm: deps.llm,
      env: deps.providerEnv,
    })
  );
}

/**
 * Build the ctx.delegate implementation for this runtime.
 *
 * The same three inputs `setupGenerate` takes, plus the two a subagent's
 * BUILTINS need — a subagent may enable `web_search` or `run_code` whether or
 * not the parent agent did, so the surface is resolved per delegation from the
 * same options the parent's builtins were.
 */
function setupSubagents(deps: ToolSetupDeps): SubagentRunner {
  return createSubagentRunner({
    llm: deps.llm,
    env: deps.providerEnv,
    ...omitUndefined({ fetch: deps.opts.fetch }),
    ...omitUndefined({ runCode: deps.opts.runCode }),
    ...omitUndefined({ logger: deps.logger }),
  });
}

/** Sandbox mode — custom tools are RPC-backed; builtins run host-side. */
function setupSandboxTools(
  deps: ToolSetupDeps,
  rpcExecuteTool: ExecuteTool,
  schemas: ToolSchema[],
): ToolSetup {
  const { agent, opts, env, workflows, notifier, logger } = deps;
  const builtinFetchOpt = opts.fetch ? { fetch: opts.fetch } : undefined;
  const generate = setupGenerate(deps);
  const subagents = setupSubagents(deps);
  const resolved = mergeBuiltinSurface(
    agent,
    builtinFetchOpt,
    {
      // Never absent — `setupTools` refuses this mode without it, so the `?? []`
      // here defaulted an unreachable path and read as a sanction for a drop.
      schemas,
      ...omitUndefined({ guidance: opts.toolGuidance }),
    },
    logger,
  );
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
        workflows: withNotify(workflows, notifier, sessionId),
        messages,
        generate,
        subagents,
        logger,
        signal: callOpts?.signal,
        timeoutMs: opts.toolTimeoutMs,
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
  const { agent, opts, env, workflows, notifier, logger, emitters, stateStore } = deps;
  const builtinOpts = {
    ...omitUndefined({ fetch: opts.fetch }),
    // The guest harness runs this path INSIDE the sandbox and provides the
    // real run_code executor; without one the builtin refuses (aai dev).
    ...omitUndefined({ runCode: opts.runCode }),
  };
  const customSchemas = agentToolsToSchemas(agent.tools ?? {});
  const builtins = mergeBuiltinSurface(agent, builtinOpts, { schemas: customSchemas }, logger);
  const allTools: Record<string, AgentDef["tools"][string]> = {
    ...builtins.defs,
    ...agent.tools,
  };
  const toolSchemas = builtins.schemas;

  const frozenEnv = Object.freeze({ ...env });

  const generate = setupGenerate(deps);
  const subagents = setupSubagents(deps);

  /**
   * `ctx.send` → client `custom_event`, with the wire caps enforced here —
   * this is the single point where a tool's send becomes a client frame now
   * that the runtime runs in-guest (the old guest→host `client/send` relay,
   * which held these checks, is gone). The decision itself is
   * `decideClientEvent` (`aai/sdk/client-event.ts`), shared with the
   * `createToolContext` double so a spec cannot assert a send this drops.
   *
   * **An UNSERIALIZABLE payload is dropped the same way, not thrown.**
   * `JSON.stringify` throws on a cycle or a `BigInt` and returns `undefined` for
   * a function — and this runs INSIDE the tool body, on the tool's own stack, so
   * a throw here failed the whole tool call: the model was told the tool failed
   * and whatever state it had already mutated was reported as a failure, for a
   * fire-and-forget notification the doc above says is droppable. Both sibling
   * stringify sites (`_state-sync.ts`, the event log) catch for exactly this
   * reason.
   *
   * **Every drop is LOGGED, including the two caps.** `ToolContext.send`'s doc
   * has always promised "dropped (with a warning log)" and the two cap checks
   * were bare `return`s — so the case an author actually hits, a payload that
   * grew past 64 KB, was the one with no signal anywhere: nothing on the wire,
   * nothing in the log, and a `sent` array in their spec that recorded it.
   */
  const sendToClient = (emitter: SessionEmitter, event: string, data: unknown): void => {
    const decision = decideClientEvent(event, data);
    if ("drop" in decision) {
      logger?.warn?.(clientEventDropMessage(event, decision.drop));
      return;
    }
    emitter.emit({ type: "custom.emitted", event, data });
  };

  /**
   * Push the agent's projected state to the client when it changed. The
   * decision (project, compare, cap) lives in `_state-sync.ts`; this is the
   * wiring and the logging.
   */
  const projections = toProjectionList(agent.syncState);
  const stateSync = projections.length > 0 ? createStateSync(projections) : undefined;
  const syncStateToClient = (
    emitter: SessionEmitter | undefined,
    sessionId: string,
    options?: { force?: boolean },
  ): void => {
    if (!(emitter && stateSync)) return;
    const result = stateSync(stateStore.syncSession(sessionId), options);
    if (result.push) {
      emitter.emit({ type: "state.updated", state: result.state });
      return;
    }
    if (result.reason === "failed") {
      logger?.warn?.(`syncState projection failed: ${result.detail}`);
    } else if (result.reason === "too-large") {
      logger?.warn?.(`syncState projection is ${result.bytes} bytes; not sent`);
    }
  };

  const executeTool = createToolDispatcher(allTools, async (tool, call) => {
    const { name, args, messages } = call;
    const sid = call.sessionId;
    /**
     * Resolved per send, never captured at dispatch. A tool call routinely
     * outlives the socket that issued it (it may run for the whole tool
     * timeout, and a session survives a disconnect through the resume grace
     * window), so by the time it sends, `emitters` may hold the RESUMED
     * connection's emitter under the same id — captured, both sends below went
     * to the superseded socket instead. For `syncState` that is worse than a
     * dropped frame: the push records the projection as delivered
     * (`lastSent` in _state-sync.ts, keyed by the state object the resume
     * shares), so the next unchanged projection is skipped and the
     * reconnected client stays stale with no further push coming.
     */
    const liveEmitter = (): SessionEmitter | undefined => emitters.get(sid);
    const run = () =>
      executeToolCall(name, args, {
        tool,
        env: frozenEnv,
        slots: stateStore.viewFor(sid),
        sessionId: sid,
        workflows: withNotify(workflows, notifier, sid),
        messages,
        generate,
        subagents,
        logger,
        // Non-fatal: the turn continues and the model still gets the failure.
        // The frame exists so a throw is VISIBLE — see `onUncaught`.
        onUncaught: (message) =>
          liveEmitter()?.emit({ type: "error.reported", code: "tool", message, fatal: false }),
        timeoutMs: opts.toolTimeoutMs,
        // Always defined: `ctx.send` is a no-op when no socket holds the id
        // (the same shape a missing sink produced before), and binding it
        // late is what lets a resumed client receive it.
        send: (event, data) => {
          const emitter = liveEmitter();
          if (emitter) sendToClient(emitter, event, data);
        },
        // Turn cancellation (barge-in/reset/stop) unblocks the tool await.
        signal: call.options?.signal,
      });
    try {
      return await run();
    } finally {
      // Both in `finally` so a throwing tool still publishes and stores what it
      // changed before it failed — a half-applied mutation the UI is not showing
      // is worse than one it is, and the same goes for one nothing stored.
      syncStateToClient(liveEmitter(), sid);
      // THE COMMIT POINT, and it is awaited. `slot.update` is synchronous by
      // contract, so it cannot await a write of its own; this is where a tool
      // call's mutations reach the backend, once per changed slot rather than
      // once per mutation. Fire-and-forget here would drop exactly the writes a
      // crash is supposed to preserve. It never rejects — see `flush`.
      await stateStore.flush(sid);
    }
  });
  /**
   * Forced, and only for a session that ALREADY has state — i.e. a resume, or a
   * reconnect onto hydrated values. A brand-new session has nothing to show.
   *
   * `store.has` is what says which: it is true once a slot has been written or
   * hydrated, which is the same question `stateMap.has(sid)` used to answer.
   */
  const pushStateSnapshot = (sessionId: string, emitter: SessionEmitter): void => {
    if (!(stateSync && stateStore.has(sessionId))) return;
    syncStateToClient(emitter, sessionId, { force: true });
  };

  /**
   * The hook commit. `emitters.get` is read AT CALL TIME for the reason
   * `liveEmitter` is inside a tool call: a session survives a disconnect through
   * the resume grace window, so the emitter under this id may be the resumed
   * connection's by now.
   *
   * Never rejects — `flush` does not, and the push is synchronous — so the
   * emitter can call it fire-and-forget.
   */
  const commitSessionState = async (sessionId: string): Promise<void> => {
    syncStateToClient(emitters.get(sessionId), sessionId);
    await stateStore.flush(sessionId);
  };

  return {
    executeTool,
    toolSchemas,
    toolGuidance: builtins.guidance,
    pushStateSnapshot,
    commitSessionState,
  };
}

/**
 * Pick the tool path: RPC-backed sandbox mode when the relay PAIR is provided.
 *
 * **Half a pair is REFUSED, because it used to select the other mode silently.**
 * `RuntimeOptions.toolSchemas` has always documented itself "required when
 * `executeTool` is provided", and what a lone half got was `setupSelfHostedTools`:
 * `createRuntime({ executeTool })` answered `{"error":"Unknown tool: …"}` to every
 * call, relay never invoked and `toolSchemas` empty, so the model was told it had
 * no tools; a lone `toolSchemas` was discarded in favour of `agent.tools`. Both are
 * a mis-wiring in OUR code (the pair is `@internal`, reached only from
 * `host-mode.ts` and the platform harness), so a construction throw naming the
 * absent option is the one failure a caller can act on — `host-mode.ts` already
 * turns it into a handshake rejection quoting it. A discriminated union on
 * `RuntimeOptions` was the candidate and is worse at both ends: it rejects a bag
 * built through `omitUndefined` (this repo's idiom widens both fields to
 * `| undefined`, matching neither arm — a compile error on a CORRECT site), and it
 * guards neither boundary that really carries them, the CLI wrapper's
 * `Record<string, unknown>` and the platform's stored JSON.
 */
export function setupTools(deps: ToolSetupDeps): ToolSetup {
  const { executeTool, toolSchemas } = deps.opts;
  // `toolSchemas: []` is a legal relay with no tools, so the test is PRESENCE.
  if (Boolean(executeTool) !== Boolean(toolSchemas)) {
    throw new Error(
      `createRuntime: the relay pair is \`executeTool\` + \`toolSchemas\`, and \`${executeTool ? "toolSchemas" : "executeTool"}\` is absent. Pass both (\`toolSchemas: []\` for a relay with no tools) or neither.`,
    );
  }
  return executeTool && toolSchemas
    ? setupSandboxTools(deps, executeTool, toolSchemas)
    : setupSelfHostedTools(deps);
}
