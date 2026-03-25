// Copyright 2025 the AAI authors. MIT license.
/**
 * S2S session — relays audio between the client and AssemblyAI's
 * Speech-to-Speech API, intercepting only tool calls for local execution.
 */

import type { AgentConfig, ToolSchema } from "./_internal-types.ts";
import { activeSessionsUpDown, sessionCounter, setupListeners } from "./_session-otel.ts";
import { errorMessage } from "./_utils.ts";
import type { ClientSink } from "./protocol.ts";
import { fromWireMessages, HOOK_TIMEOUT_MS } from "./protocol.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";
import {
  type CreateS2sWebSocket,
  connectS2s,
  defaultCreateS2sWebSocket,
  type S2sHandle,
  type S2sToolSchema,
} from "./s2s.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import type { Message, StepInfo } from "./types.ts";
import type { ExecuteTool } from "./worker-entry.ts";

export { buildSystemPrompt } from "./system-prompt.ts";

/** A voice session managing the S2S connection for one client. */
export type Session = {
  start(): Promise<void>;
  stop(): Promise<void>;
  onAudio(data: Uint8Array): void;
  onAudioReady(): void;
  onCancel(): void;
  onReset(): void;
  onHistory(incoming: readonly { role: "user" | "assistant"; text: string }[]): void;
  waitForTurn(): Promise<void>;
};

/** Generic interface for invoking agent lifecycle hooks. */
export type HookInvoker = {
  onConnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onDisconnect(sessionId: string, timeoutMs?: number): Promise<void>;
  onTurn(sessionId: string, text: string, timeoutMs?: number): Promise<void>;
  onError(sessionId: string, error: { message: string }, timeoutMs?: number): Promise<void>;
  onStep(sessionId: string, step: StepInfo, timeoutMs?: number): Promise<void>;
  resolveTurnConfig(
    sessionId: string,
    stepNumber: number,
    timeoutMs?: number,
  ): Promise<{ maxSteps?: number; activeTools?: string[] } | null>;
};

/** Configuration options for creating a new session. */
export type SessionOptions = {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  toolSchemas: readonly ToolSchema[];
  apiKey: string;
  s2sConfig: S2SConfig;
  executeTool: ExecuteTool;
  createWebSocket?: CreateS2sWebSocket;
  env?: Record<string, string | undefined>;
  hookInvoker?: HookInvoker;
  skipGreeting?: boolean;
  logger?: Logger;
};

export const _internals = {
  connectS2s,
};

// ─── Session context ─────────────────────────────────────────────────────────

type PendingTool = { call_id: string; result: string };

/** Mutable state + dependencies shared across session helper functions. */
export type S2sSessionCtx = {
  readonly id: string;
  readonly agent: string;
  readonly client: ClientSink;
  readonly agentConfig: AgentConfig;
  readonly executeTool: ExecuteTool;
  readonly log: Logger;
  s2s: S2sHandle | null;
  pendingTools: PendingTool[];
  toolCallCount: number;
  turnPromise: Promise<void> | null;
  conversationMessages: Message[];
  resolveTurnConfig(): Promise<{ maxSteps?: number; activeTools?: string[] } | null>;
  checkTurnLimits(
    turnConfig: { maxSteps?: number; activeTools?: string[] } | null,
    name: string,
  ): string | null;
  fireHook(name: string, fn: (h: HookInvoker) => Promise<void>): void;
};

function buildCtx(opts: {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  hookInvoker: HookInvoker | undefined;
  log: Logger;
}): S2sSessionCtx {
  const { id, agentConfig, hookInvoker, log } = opts;
  const ctx: S2sSessionCtx = {
    ...opts,
    s2s: null,
    pendingTools: [],
    toolCallCount: 0,
    turnPromise: null,
    conversationMessages: [],
    resolveTurnConfig() {
      if (!hookInvoker) return Promise.resolve(null);
      return hookInvoker.resolveTurnConfig(id, ctx.toolCallCount, HOOK_TIMEOUT_MS);
    },
    checkTurnLimits(turnConfig, name) {
      const maxSteps = turnConfig?.maxSteps ?? agentConfig.maxSteps;
      ctx.toolCallCount++;
      if (maxSteps !== undefined && ctx.toolCallCount > maxSteps) {
        log.info("maxSteps exceeded, refusing tool call", {
          toolCallCount: ctx.toolCallCount,
          maxSteps,
        });
        return "Maximum tool steps reached. Please respond to the user now.";
      }
      if (turnConfig?.activeTools && !turnConfig.activeTools.includes(name)) {
        log.info("Tool filtered by activeTools", { name });
        return JSON.stringify({ error: `Tool "${name}" is not available at this step.` });
      }
      return null;
    },
    fireHook(name, fn) {
      if (!hookInvoker) return;
      try {
        fn(hookInvoker).catch((err: unknown) =>
          log.warn(`${name} hook failed`, { err: errorMessage(err) }),
        );
      } catch (err: unknown) {
        log.warn(`${name} hook failed`, { err: errorMessage(err) });
      }
    },
  };
  return ctx;
}

// ─── Main session factory ────────────────────────────────────────────────────

/** Create an S2S-backed session with the same interface as the STT+LLM+TTS session. */
export function createS2sSession(opts: SessionOptions): Session {
  const {
    id,
    agent,
    client,
    toolSchemas,
    apiKey,
    s2sConfig,
    executeTool,
    createWebSocket = defaultCreateS2sWebSocket,
    hookInvoker,
    logger: log = consoleLogger,
  } = opts;
  const agentConfig = opts.skipGreeting ? { ...opts.agentConfig, greeting: "" } : opts.agentConfig;
  const hasTools = toolSchemas.length > 0 || (agentConfig.builtinTools?.length ?? 0) > 0;
  const systemPrompt = buildSystemPrompt(agentConfig, { hasTools, voice: true });
  const s2sTools: S2sToolSchema[] = toolSchemas.map((ts) => ({
    type: "function" as const,
    name: ts.name,
    description: ts.description,
    parameters: ts.parameters,
  }));

  const sessionAbort = new AbortController();
  const ctx = buildCtx({ id, agent, client, agentConfig, executeTool, hookInvoker, log });

  async function connectAndSetup(): Promise<void> {
    try {
      const handle = await _internals.connectS2s({
        apiKey,
        config: s2sConfig,
        createWebSocket,
        logger: log,
      });
      setupListeners(ctx, handle);
      handle.updateSession({
        system_prompt: systemPrompt,
        tools: s2sTools,
        ...(agentConfig.greeting ? { greeting: agentConfig.greeting } : {}),
      });
      ctx.s2s = handle;
    } catch (err: unknown) {
      const msg = errorMessage(err);
      log.error("S2S connect failed", { error: msg });
      client.event({ type: "error", code: "internal", message: msg });
    }
  }

  return {
    async start(): Promise<void> {
      sessionCounter.add(1, { agent });
      activeSessionsUpDown.add(1, { agent });
      ctx.fireHook("onConnect", (h) => h.onConnect(id, HOOK_TIMEOUT_MS));
      await connectAndSetup();
    },
    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      sessionAbort.abort();
      activeSessionsUpDown.add(-1, { agent });
      if (ctx.turnPromise !== null) await ctx.turnPromise;
      ctx.s2s?.close();
      ctx.fireHook("onDisconnect", (h) => h.onDisconnect(id, HOOK_TIMEOUT_MS));
    },
    onAudio(data: Uint8Array): void {
      ctx.s2s?.sendAudio(data);
    },
    onAudioReady(): void {
      /* S2S greeting comes automatically */
    },
    onCancel(): void {
      client.event({ type: "cancelled" });
    },
    onReset(): void {
      ctx.conversationMessages = [];
      ctx.toolCallCount = 0;
      ctx.turnPromise = null;
      ctx.pendingTools = [];
      ctx.s2s?.close();
      client.event({ type: "reset" });
      connectAndSetup().catch((err: unknown) =>
        log.error("S2S reset reconnect failed", { error: errorMessage(err) }),
      );
    },
    onHistory(incoming: readonly { role: "user" | "assistant"; text: string }[]): void {
      ctx.conversationMessages.push(...fromWireMessages(incoming));
    },
    waitForTurn(): Promise<void> {
      return ctx.turnPromise ?? Promise.resolve();
    },
  };
}
