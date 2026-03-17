// Copyright 2025 the AAI authors. MIT license.
/**
 * Direct tool execution for self-hosted mode.
 *
 * In self-hosted mode, agent code is trusted (you're running your own code).
 * Tools execute directly in-process — no sandbox, no RPC.
 *
 * @module
 */

import { agentToolsToSchemas, type ToolSchema } from "./_internal_types.ts";
import { getBuiltinToolDefs, getBuiltinToolSchemas } from "./builtin_tools.ts";
import type { Kv } from "./kv.ts";
import { createMemoryKv } from "./kv.ts";
import type { HookInvoker } from "./session.ts";
import type { AgentDef, HookContext, StepInfo } from "./types.ts";
import type { ExecuteTool } from "./worker_entry.ts";
import { executeToolCall } from "./worker_entry.ts";

export type DirectExecutorOptions = {
  agent: AgentDef;
  env: Record<string, string>;
  kv?: Kv | undefined;
  vectorSearch?: ((query: string, topK: number) => Promise<string>) | undefined;
};

export type DirectExecutor = {
  executeTool: ExecuteTool;
  hookInvoker: HookInvoker;
  toolSchemas: ToolSchema[];
};

/** Create a direct (in-process) tool executor and hook invoker for an agent. */
export function createDirectExecutor(opts: DirectExecutorOptions): DirectExecutor {
  const { agent, env, kv = createMemoryKv(), vectorSearch } = opts;

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
  const sessionState = new Map<string, unknown>();
  const frozenEnv = Object.freeze({ ...env });

  function getState(sessionId: string): unknown {
    if (!sessionState.has(sessionId) && agent.state) {
      sessionState.set(sessionId, agent.state());
    }
    return sessionState.get(sessionId) ?? {};
  }

  function makeHookContext(sessionId: string): HookContext {
    return {
      sessionId,
      env: frozenEnv,
      state: getState(sessionId) as Record<string, unknown>,
      get kv() {
        return kv;
      },
    };
  }

  const executeTool: ExecuteTool = async (name, args, sessionId, messages) => {
    const tool = allTools[name];
    if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });

    return executeToolCall(name, args, {
      tool,
      env: frozenEnv,
      sessionId,
      state: getState(sessionId ?? ""),
      kv,
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

  return { executeTool, hookInvoker, toolSchemas };
}
