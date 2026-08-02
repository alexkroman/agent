// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool-surface assembly for the agent runtime.
 *
 * {@link setupTools} builds the runtime's tool dispatcher, schemas, and LLM
 * guidance for both execution modes — RPC-backed sandbox mode (platform)
 * and in-process self-hosted mode.
 */

import { agentToolsToSchemas, type ToolSchema } from "../sdk/_internal-types.ts";
import {
  DEFAULT_BUILTIN_TOOLS,
  MAX_CLIENT_EVENT_NAME_LENGTH,
  MAX_CLIENT_EVENT_PAYLOAD_BYTES,
} from "../sdk/constants.ts";
import type { Db } from "../sdk/db.ts";
import type { AgentEnv, ProviderEnv } from "../sdk/env-types.ts";
import type { OwnedMap } from "../sdk/owned-map.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import type { AgentDef, ToolDef } from "../sdk/types.ts";
import { toolError } from "../sdk/utils.ts";
import { createStateSync } from "./_state-sync.ts";
import { resolveAllBuiltins, SANDBOX_ONLY_BUILTINS } from "./builtin-tools.ts";
import { createGenerateFn, type HostGenerateFn } from "./generate.ts";
import type { RuntimeOptions } from "./runtime-types.ts";
import { type ExecuteTool, executeToolCall } from "./tool-executor.ts";

/**
 * Resolve builtins for the sandbox/relay tool path — the single owner of that
 * decision for every caller (platform sandbox, relay/host mode, self-hosted).
 * Callers supply the tools they dispatch themselves via `toolSchemas`; a
 * supplied tool with the same name as a builtin wins, and the colliding builtin
 * is dropped from both dispatch and schemas so the host never shadows a tool
 * the caller expects to execute and the LLM never sees a duplicate name.
 */
function resolveSandboxBuiltins(
  agent: AgentDef,
  opts: RuntimeOptions,
  fetchOpt: { fetch: typeof globalThis.fetch } | undefined,
): {
  defs: Record<string, ToolDef>;
  schemas: ToolSchema[];
  guidance: string[];
} {
  const providedSchemas = opts.toolSchemas ?? [];
  const providedNames = new Set(providedSchemas.map((s) => s.name));
  const names = (agent.builtinTools ?? DEFAULT_BUILTIN_TOOLS).filter(
    (name) => !providedNames.has(name),
  );
  const builtins = resolveAllBuiltins(names, fetchOpt);
  return {
    defs: builtins.defs,
    schemas: [...providedSchemas, ...builtins.schemas],
    guidance: [...(opts.toolGuidance ?? []), ...builtins.guidance],
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
  /** Becomes `ctx.env` (frozen) — agent-owned only, see sdk/env-types.ts. */
  env: AgentEnv;
  providerEnv: ProviderEnv;
  /** ctx.db when storage is enabled; undefined makes ctx.db access throw. */
  resolvedDb: Db | undefined;
  logger: NonNullable<RuntimeOptions["logger"]>;
  sinkMap: OwnedMap<string, ClientSink>;
  /** Per-session tool state (self-hosted mode only); cleaned up on session end. */
  stateMap: Map<string, Record<string, unknown>>;
};

/**
 * Build the ctx.generate implementation for this runtime: the agent's
 * effective LLM descriptor (platform passes it as a runtime option, `aai dev`
 * reads the agent's own field) with credentials from `providerEnv`.
 */
function setupGenerate(deps: ToolSetupDeps): HostGenerateFn {
  return createGenerateFn({
    llm: deps.opts.llm ?? deps.agent.llm,
    env: deps.providerEnv,
  });
}

/** Sandbox mode — custom tools are RPC-backed; builtins run host-side. */
function setupSandboxTools(deps: ToolSetupDeps, rpcExecuteTool: ExecuteTool): ToolSetup {
  const { agent, opts, env, resolvedDb, logger } = deps;
  const builtinFetchOpt = opts.fetch ? { fetch: opts.fetch } : undefined;
  const generate = setupGenerate(deps);
  const resolved = resolveSandboxBuiltins(agent, opts, builtinFetchOpt);
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
  const { agent, opts, env, resolvedDb, logger, sinkMap, stateMap } = deps;
  const builtinOpts = {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    // The guest harness runs this path INSIDE the sandbox and provides the
    // real run_code executor; without one the builtin refuses (aai dev).
    ...(opts.runCode ? { runCode: opts.runCode } : {}),
  };
  const customNames = new Set(Object.keys(agent.tools ?? {}));
  const builtinNames = (agent.builtinTools ?? DEFAULT_BUILTIN_TOOLS).filter(
    (name) => !customNames.has(name),
  );
  const builtins = resolveAllBuiltins(builtinNames, builtinOpts);
  const allTools: Record<string, AgentDef["tools"][string]> = {
    ...builtins.defs,
    ...agent.tools,
  };
  const customSchemas = agentToolsToSchemas(agent.tools ?? {});
  const toolSchemas = [...customSchemas, ...builtins.schemas];

  const getState = (sid: string) => {
    if (!stateMap.has(sid) && agent.state) stateMap.set(sid, agent.state());
    return stateMap.get(sid) ?? {};
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
    if (!tool) return toolError(`Unknown tool: ${name}`);
    const sink = sinkMap.get(sessionId ?? "");
    const run = () =>
      executeToolCall(name, args, {
        tool,
        env: frozenEnv,
        state: getState(sessionId ?? ""),
        sessionId: sessionId ?? "",
        // db traffic is a TCP socket, not fetch, so the egress guard never
        // sees it — no exemption wrapper needed.
        db: resolvedDb,
        messages,
        generate,
        logger,
        send: sink ? (event, data) => sendToClient(sink, event, data) : undefined,
        // Turn cancellation (barge-in/reset/stop) unblocks the tool await.
        signal: callOpts?.signal,
      });
    try {
      return await run();
    } finally {
      // In `finally` so a throwing tool still publishes what it changed
      // before it failed — a half-applied mutation the UI is not showing is
      // worse than one it is.
      syncStateToClient(sink, getState(sessionId ?? ""));
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
