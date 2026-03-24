// Copyright 2025 the AAI authors. MIT license.
/**
 * Direct tool execution for self-hosted mode.
 *
 * In self-hosted mode, agent code is trusted (you're running your own code).
 * Tools execute directly in-process — no sandbox, no RPC.
 *
 * @module
 */

import { type AgentConfig, agentToolsToSchemas, type ToolSchema } from "./_internal_types.ts";
import { getBuiltinToolDefs, getBuiltinToolSchemas } from "./builtin_tools.ts";
import type { Kv } from "./kv.ts";
import { createMemoryKv } from "./kv.ts";
import type { ClientSink } from "./protocol.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger, DEFAULT_S2S_CONFIG } from "./runtime.ts";
import type { CreateS2sWebSocket } from "./s2s.ts";
import { createS2sSession, type HookInvoker, type Session } from "./session.ts";
import type { AgentDef, HookContext, StepInfo } from "./types.ts";
import type { VectorStore } from "./vector.ts";
import { createMemoryVectorStore } from "./vector.ts";
import type { ExecuteTool } from "./worker_entry.ts";
import { executeToolCall } from "./worker_entry.ts";

export type DirectExecutorOptions = {
  agent: AgentDef;
  env: Record<string, string>;
  kv?: Kv | undefined;
  vector?: VectorStore | undefined;
  vectorSearch?: ((query: string, topK: number) => Promise<string>) | undefined;
  createWebSocket?: CreateS2sWebSocket | undefined;
  logger?: Logger | undefined;
  s2sConfig?: S2SConfig | undefined;
};

export type DirectExecutor = {
  executeTool: ExecuteTool;
  hookInvoker: HookInvoker;
  toolSchemas: ToolSchema[];
  createSession(opts: {
    id: string;
    agent: string;
    client: ClientSink;
    skipGreeting?: boolean;
  }): Session;
};

/** Build a serializable AgentConfig from an AgentDef. */
export function buildAgentConfig(agent: AgentDef): AgentConfig {
  const config: AgentConfig = {
    name: agent.name,
    instructions: agent.instructions,
    greeting: agent.greeting,
  };
  if (agent.sttPrompt !== undefined) config.sttPrompt = agent.sttPrompt;
  if (typeof agent.maxSteps !== "function") config.maxSteps = agent.maxSteps;
  if (agent.toolChoice !== undefined) config.toolChoice = agent.toolChoice;
  if (agent.builtinTools) config.builtinTools = [...agent.builtinTools];
  if (agent.activeTools) config.activeTools = [...agent.activeTools];
  return config;
}

/** Create a direct (in-process) tool executor and hook invoker for an agent. */
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
  const sessionState = new Map<string, Record<string, unknown>>();
  const frozenEnv = Object.freeze({ ...env });

  function getState(sessionId: string): Record<string, unknown> {
    if (!sessionState.has(sessionId) && agent.state) {
      sessionState.set(sessionId, agent.state() as Record<string, unknown>);
    }
    return sessionState.get(sessionId) ?? {};
  }

  function makeHookContext(sessionId: string): HookContext {
    return {
      env: frozenEnv,
      state: getState(sessionId),
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
      state: getState(sessionId ?? ""),
      kv,
      vector,
      messages,
    });
  };

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
    async resolveTurnConfig(sessionId) {
      const ctx = makeHookContext(sessionId);
      let maxSteps: number | undefined;
      let activeTools: string[] | undefined;

      if (typeof agent.maxSteps === "function") {
        maxSteps = (await agent.maxSteps(ctx)) ?? undefined;
      }

      if (agent.onBeforeStep) {
        const result = await agent.onBeforeStep(0, ctx);
        activeTools = result?.activeTools;
      }

      if (maxSteps === undefined && activeTools === undefined) return null;
      const config: { maxSteps?: number; activeTools?: string[] } = {};
      if (maxSteps !== undefined) config.maxSteps = maxSteps;
      if (activeTools !== undefined) config.activeTools = activeTools;
      return config;
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
