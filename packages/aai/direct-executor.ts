// Copyright 2025 the AAI authors. MIT license.
/**
 * Direct tool execution for self-hosted mode.
 *
 * In self-hosted mode, agent code is trusted (you're running your own code).
 * Tools execute directly in-process — no sandbox, no RPC.
 */

import {
  type AgentConfig,
  agentToolsToSchemas,
  type ToolSchema,
  toAgentConfig,
} from "./_internal-types.ts";
import { createSessionStateMap } from "./_utils.ts";
import { getBuiltinToolDefs, getBuiltinToolSchemas } from "./builtin-tools.ts";
import type { Kv } from "./kv.ts";
import { createMemoryKv } from "./kv.ts";
import {
  runAfterToolCallMiddleware,
  runAfterTurnMiddleware,
  runBeforeTurnMiddleware,
  runOutputFilters,
  runToolCallInterceptors,
} from "./middleware.ts";
import type { ClientSink } from "./protocol.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import { createS2sSession, type HookInvoker, type Session } from "./session.ts";
import type { AgentDef, HookContext, Middleware, StepInfo } from "./types.ts";
import type { VectorStore } from "./vector.ts";
import { createMemoryVectorStore } from "./vector.ts";
import type { ExecuteTool } from "./worker-entry.ts";
import { executeToolCall } from "./worker-entry.ts";

/**
 * Configuration for creating a direct (in-process) tool executor for self-hosted mode.
 *
 * In self-hosted mode, agent tools run directly in the Node process — no sandbox or
 * RPC layer. This type configures the agent, environment, stores, and logging.
 */
export type DirectExecutorOptions = {
  agent: AgentDef;
  env: Record<string, string>;
  kv?: Kv | undefined;
  vector?: VectorStore | undefined;
  /** Vector search callback. Accepts a query and topK, returns a JSON string.
   *  Used as an RPC proxy in platform mode; in self-hosted mode the default
   *  uses the local `vector` store directly. */
  vectorSearch?: ((query: string, topK: number) => Promise<string>) | undefined;
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

/** Build a serializable AgentConfig from an AgentDef. */
export function buildAgentConfig(agent: AgentDef): AgentConfig {
  return toAgentConfig(agent);
}

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
    kv = createMemoryKv(),
    vector = createMemoryVectorStore(),
    vectorSearch,
    createWebSocket,
    logger = consoleLogger,
    s2sConfig = DEFAULT_S2S_CONFIG,
  } = opts;
  const agentConfig = buildAgentConfig(agent);

  // Merge custom + builtin tool definitions
  const builtinDefs = getBuiltinToolDefs(
    agent.builtinTools ?? [],
    vectorSearch ? { vectorSearch } : undefined,
  );
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

  function makeHookContext(sessionId: string): HookContext {
    return {
      env: frozenEnv,
      state: sessionState.get(sessionId),
      get kv() {
        return kv;
      },
      get vector() {
        return vector;
      },
    };
  }

  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    const tool = allTools[name];
    if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });

    return executeToolCall(name, args, {
      tool,
      env: frozenEnv,
      state: sessionState.get(sessionId ?? ""),
      kv,
      vector,
      messages,
      logger,
    });
  };

  const middleware: readonly Middleware[] = agent.middleware ?? [];

  const hookInvoker: HookInvoker = {
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
    async onStep(sessionId, step: StepInfo) {
      await agent.onStep?.(step, makeHookContext(sessionId));
    },
    async resolveTurnConfig(sessionId, stepNumber) {
      const ctx = makeHookContext(sessionId);
      const maxSteps =
        typeof agent.maxSteps === "function"
          ? ((await agent.maxSteps(ctx)) ?? undefined)
          : undefined;
      const activeTools = agent.onBeforeStep
        ? (await agent.onBeforeStep(stepNumber, ctx))?.activeTools
        : undefined;

      if (maxSteps === undefined && activeTools === undefined) return null;
      return { ...(maxSteps !== undefined && { maxSteps }), ...(activeTools && { activeTools }) };
    },

    // ── Middleware hooks ───────────────────────────────────────────────
    async beforeTurn(sessionId, text) {
      if (middleware.length === 0) return;
      const ctx = makeHookContext(sessionId);
      const result = await runBeforeTurnMiddleware(middleware, text, ctx);
      return result?.reason;
    },
    async afterTurn(sessionId, text) {
      if (middleware.length === 0) return;
      const ctx = makeHookContext(sessionId);
      await runAfterTurnMiddleware(middleware, text, ctx);
    },
    async interceptToolCall(sessionId, toolName, args) {
      if (middleware.length === 0) return;
      const ctx = makeHookContext(sessionId);
      return runToolCallInterceptors(middleware, toolName, args, ctx);
    },
    async afterToolCall(sessionId, toolName, args, result) {
      if (middleware.length === 0) return;
      const ctx = makeHookContext(sessionId);
      await runAfterToolCallMiddleware(middleware, toolName, args, result, ctx);
    },
    async filterOutput(sessionId, text) {
      if (middleware.length === 0) return text;
      const ctx = makeHookContext(sessionId);
      return runOutputFilters(middleware, text, ctx);
    },
  };

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
