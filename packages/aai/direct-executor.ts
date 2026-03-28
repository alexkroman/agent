// Copyright 2025 the AAI authors. MIT license.
/**
 * Direct tool execution for self-hosted mode.
 *
 * In self-hosted mode, agent code is trusted (you're running your own code).
 * Tools execute directly in-process — no sandbox, no RPC.
 */

import { createStorage } from "unstorage";
import { agentToolsToSchemas, type ToolSchema, toAgentConfig } from "./_internal-types.ts";
import { ssrfSafeFetch } from "./_ssrf.ts";
import { createSessionStateMap, toolError } from "./_utils.ts";
import { getBuiltinToolDefs, getBuiltinToolSchemas } from "./builtin-tools.ts";
import type { Kv } from "./kv.ts";
import type { HookInvoker, LifecycleHooks } from "./middleware.ts";
import { buildMiddlewareRunner } from "./middleware.ts";
import type { ClientSink } from "./protocol.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import { createS2sSession, type Session } from "./session.ts";
import type { AgentDef, HookContext } from "./types.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";
import type { ExecuteTool } from "./worker-entry.ts";
import { executeToolCall } from "./worker-entry.ts";

/** Create an in-memory KV store (default for self-hosted). */
function createLocalKv(): Kv {
  return createUnstorageKv({ storage: createStorage() });
}

/**
 * Configuration for creating a direct (in-process) tool executor for self-hosted mode.
 *
 * In self-hosted mode, agent tools run directly in the Node process — no sandbox or
 * RPC layer. This type configures the agent, environment, stores, and logging.
 */
export type DirectExecutorOptions = {
  // biome-ignore lint/suspicious/noExplicitAny: accepts any state type
  agent: AgentDef<any>;
  env: Record<string, string>;
  kv?: Kv | undefined;
  /** Custom WebSocket factory for the S2S connection (useful for testing). */
  createWebSocket?: CreateS2sWebSocket | undefined;
  logger?: Logger | undefined;
  s2sConfig?: S2SConfig | undefined;
};

/**
 * The direct (in-process) executor returned by {@link createDirectExecutor}.
 *
 * Provides tool execution, hook invocation, tool schemas for the S2S API,
 * and a factory for creating voice sessions.
 */
export type DirectExecutor = {
  /** Execute a named tool with the given args, returning a JSON result string. */
  executeTool: ExecuteTool;
  /** Hook invoker wired to the agent's lifecycle hooks and middleware. */
  hookInvoker: HookInvoker;
  /** Tool schemas registered with the S2S API (custom + built-in). */
  toolSchemas: ToolSchema[];
  /** Create a new voice session for a connected client. */
  createSession(opts: {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
  }): Session;
};

/**
 * Create a direct (in-process) tool executor and hook invoker for an agent.
 *
 * Merges built-in and custom tool definitions, builds tool schemas for the
 * S2S API, and wires up middleware and lifecycle hooks.
 *
 * @param opts - Executor configuration. See {@link DirectExecutorOptions}.
 * @returns A {@link DirectExecutor} with tool execution, hook invocation,
 *   schemas, and session creation.
 */
export function createDirectExecutor(opts: DirectExecutorOptions): DirectExecutor {
  const {
    agent,
    env,
    kv = createLocalKv(),
    createWebSocket,
    logger = consoleLogger,
    s2sConfig = DEFAULT_S2S_CONFIG,
  } = opts;
  const agentConfig = toAgentConfig(agent);

  // Merge custom + builtin tool definitions
  const builtinDefs = getBuiltinToolDefs(agent.builtinTools ?? []);
  const allTools: Record<string, AgentDef["tools"][string]> = {
    ...builtinDefs,
    ...agent.tools,
  };

  // Build tool schemas for the S2S API
  const customSchemas = agentToolsToSchemas(agent.tools ?? {});
  const builtinSchemas = getBuiltinToolSchemas(agent.builtinTools ?? []);
  const toolSchemas: ToolSchema[] = [...customSchemas, ...builtinSchemas];

  // Per-session mutable state
  const sessionState = createSessionStateMap(agent.state);
  const frozenEnv = Object.freeze({ ...env });

  /** SSRF-safe fetch for tool/hook contexts in self-hosted mode. */
  const safeFetch: typeof globalThis.fetch = (input, init) => {
    const req = new Request(input, init);
    return ssrfSafeFetch(req.url, { ...init, method: req.method }, globalThis.fetch);
  };

  function makeHookContext(sessionId: string): HookContext {
    return {
      env: frozenEnv,
      state: sessionState.get(sessionId),
      sessionId,
      get kv() {
        return kv;
      },
      fetch: safeFetch,
    };
  }

  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    const tool = allTools[name];
    if (!tool) return toolError(`Unknown tool: ${name}`);

    return executeToolCall(name, args, {
      tool,
      env: frozenEnv,
      state: sessionState.get(sessionId ?? ""),
      sessionId: sessionId ?? "",
      kv,
      messages,
      logger,
      fetch: safeFetch,
    });
  };

  // ── Lifecycle hooks (always present) ─────────────────────────────────
  const lifecycleHooks: LifecycleHooks = {
    async onConnect(sessionId) {
      await agent.onConnect?.(makeHookContext(sessionId));
    },
    async onDisconnect(sessionId) {
      await agent.onDisconnect?.(makeHookContext(sessionId));
      sessionState.delete(sessionId);
    },
    async onTurn(sessionId, text) {
      await agent.onTurn?.(text, makeHookContext(sessionId));
    },
    async onError(sessionId, error) {
      await agent.onError?.(new Error(error.message), makeHookContext(sessionId));
    },
    async resolveTurnConfig(sessionId) {
      const ctx = makeHookContext(sessionId);
      const maxSteps =
        typeof agent.maxSteps === "function"
          ? ((await agent.maxSteps(ctx)) ?? undefined)
          : undefined;
      if (maxSteps === undefined) return null;
      return { maxSteps };
    },
  };

  // ── Middleware runner (only built when middleware exists) ────────────
  const middlewareRunner = buildMiddlewareRunner(agent.middleware ?? [], makeHookContext);
  const hookInvoker: HookInvoker = { ...lifecycleHooks, ...middlewareRunner };

  function createSession(sessionOpts: {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
  }): Session {
    const apiKey = frozenEnv.ASSEMBLYAI_API_KEY ?? "";
    return createS2sSession({
      id: sessionOpts.id,
      agent: sessionOpts.agent,
      client: sessionOpts.client,
      agentConfig,
      toolSchemas,
      apiKey,
      s2sConfig,
      executeTool,
      ...(createWebSocket ? { createWebSocket } : {}),
      hookInvoker,
      skipGreeting: sessionOpts.skipGreeting ?? false,
      logger,
    });
  }

  return { executeTool, hookInvoker, toolSchemas, createSession };
}
