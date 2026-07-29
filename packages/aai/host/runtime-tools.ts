// Copyright 2026 the AAI authors. MIT license.
/**
 * Tool-surface assembly for the agent runtime.
 *
 * {@link setupTools} builds the runtime's tool dispatcher, schemas, and LLM
 * guidance for both execution modes — RPC-backed sandbox mode (platform)
 * and in-process self-hosted mode — including the `send_message` builtin
 * registered when the agent declares a send channel.
 */

import { agentToolsToSchemas, type ToolSchema } from "../sdk/_internal-types.ts";
import { DEFAULT_BUILTIN_TOOLS } from "../sdk/constants.ts";
import type { Kv } from "../sdk/kv.ts";
import type { ClientSink } from "../sdk/protocol.ts";
import { openSender } from "../sdk/providers/send/open.ts";
import type { AgentDef, ToolDef } from "../sdk/types.ts";
import { toolError } from "../sdk/utils.ts";
import type { Vector } from "../sdk/vector.ts";
import { resolveSendBuiltin, SEND_MESSAGE_TOOL } from "./builtin-send.ts";
import { resolveAllBuiltins, SANDBOX_ONLY_BUILTINS, safeFetch } from "./builtin-tools.ts";
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

/**
 * Resolve the agent's send channel into the `send_message` builtin, or null
 * when no channel is declared. A custom or relayed tool with the same name
 * wins — the builtin is skipped, matching the collision rule every other
 * builtin follows. Credentials resolve from `providerEnv`; the network side
 * goes through the runtime's (SSRF-guarded) fetch.
 */
function resolveSendMessage(
  agent: AgentDef,
  providerEnv: Record<string, string>,
  fetchImpl: typeof globalThis.fetch,
  takenNames: ReadonlySet<string>,
): ReturnType<typeof resolveSendBuiltin> | null {
  if (!agent.send || takenNames.has(SEND_MESSAGE_TOOL)) return null;
  return resolveSendBuiltin(openSender(agent.send, providerEnv, { fetch: fetchImpl }));
}

/** The runtime's resolved tool surface: dispatcher, schemas, and LLM guidance. */
type ToolSetup = {
  executeTool: ExecuteTool;
  toolSchemas: ToolSchema[];
  toolGuidance: string[];
};

/** Runtime state the tool-setup paths close over. */
type ToolSetupDeps = {
  agent: AgentDef;
  opts: RuntimeOptions;
  env: Record<string, string>;
  providerEnv: Record<string, string>;
  resolvedKv: Kv;
  resolvedVector: Vector;
  logger: NonNullable<RuntimeOptions["logger"]>;
  sinkMap: Map<string, ClientSink>;
  /** Per-session tool state (self-hosted mode only); cleaned up on session end. */
  stateMap: Map<string, Record<string, unknown>>;
};

type SendTool = ReturnType<typeof resolveSendBuiltin> | null;

/** Sandbox mode — custom tools are RPC-backed; builtins run host-side. */
function setupSandboxTools(
  deps: ToolSetupDeps,
  rpcExecuteTool: ExecuteTool,
  sendTool: SendTool,
): ToolSetup {
  const { agent, opts, env, resolvedKv, resolvedVector, logger } = deps;
  const builtinFetchOpt = opts.fetch ? { fetch: opts.fetch } : undefined;
  const resolved = resolveSandboxBuiltins(agent, opts, builtinFetchOpt);
  const builtinDefs = resolved.defs;
  let toolSchemas = resolved.schemas;
  if (sendTool) {
    builtinDefs[SEND_MESSAGE_TOOL] = sendTool.def;
    toolSchemas = [...toolSchemas, sendTool.schema];
  }
  const frozenEnv = Object.freeze({ ...env });

  const executeTool: ExecuteTool = async (name, args, sessionId, messages, callOpts) => {
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
  return { executeTool, toolSchemas, toolGuidance: resolved.guidance };
}

/**
 * Self-hosted mode — in-process tool execution. A custom tool with the
 * same name as a builtin wins: the builtin is dropped from both dispatch
 * and schemas rather than emitting a duplicate schema name to the LLM.
 */
function setupSelfHostedTools(deps: ToolSetupDeps, sendTool: SendTool): ToolSetup {
  const { agent, opts, env, resolvedKv, resolvedVector, logger, sinkMap, stateMap } = deps;
  const builtinFetchOpt = opts.fetch ? { fetch: opts.fetch } : undefined;
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
  const toolSchemas = [...customSchemas, ...builtins.schemas];
  if (sendTool) {
    allTools[SEND_MESSAGE_TOOL] = sendTool.def;
    toolSchemas.push(sendTool.schema);
  }

  const getState = (sid: string) => {
    if (!stateMap.has(sid) && agent.state) stateMap.set(sid, agent.state());
    return stateMap.get(sid) ?? {};
  };
  const frozenEnv = Object.freeze({ ...env });

  const executeTool: ExecuteTool = async (name, args, sessionId, messages, callOpts) => {
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
  return { executeTool, toolSchemas, toolGuidance: builtins.guidance };
}

/** Pick the tool path: RPC-backed sandbox mode when overrides are provided. */
export function setupTools(deps: ToolSetupDeps): ToolSetup {
  const { executeTool, toolSchemas } = deps.opts;
  // Resolve the send builtin once for either path. Which names are "taken"
  // differs by mode: relayed schemas in sandbox mode, custom tools otherwise.
  const takenNames =
    executeTool && toolSchemas
      ? new Set(toolSchemas.map((s) => s.name))
      : new Set(Object.keys(deps.agent.tools ?? {}));
  const sendTool = resolveSendMessage(
    deps.agent,
    deps.providerEnv,
    deps.opts.fetch ?? safeFetch,
    takenNames,
  );
  return executeTool && toolSchemas
    ? setupSandboxTools(deps, executeTool, sendTool)
    : setupSelfHostedTools(deps, sendTool);
}
