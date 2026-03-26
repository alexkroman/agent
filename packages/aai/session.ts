// Copyright 2025 the AAI authors. MIT license.
/** S2S session — relays audio between client and AssemblyAI S2S API. */

import type { AgentConfig, ToolSchema } from "./_internal-types.ts";
import { activeSessionsUpDown, sessionCounter, setupListeners } from "./_session-otel.ts";
import { errorDetail, errorMessage } from "./_utils.ts";
import type { HookInvoker } from "./middleware.ts";
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
import type { Message } from "./types.ts";
import type { ExecuteTool } from "./worker-entry.ts";

export type { HookInvoker, ToolInterceptResult } from "./middleware.ts";
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

/** Configuration options for creating a new session. */
export type S2sSessionOptions = {
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
  /** Maximum number of conversation messages to retain. Older messages are
   *  dropped (sliding window) to bound memory in long-running sessions.
   *  Defaults to 200. Set to 0 or Infinity to disable trimming. */
  maxHistory?: number;
};

/** @internal Not part of the public API. Exposed for testing only. */
export const _internals = {
  connectS2s,
};

// ─── Session context ─────────────────────────────────────────────────────────

type PendingTool = { callId: string; result: string };

/** Mutable state + dependencies shared across session helper functions. */
export type S2sSessionCtx = {
  readonly id: string;
  readonly agent: string;
  readonly client: ClientSink;
  readonly agentConfig: AgentConfig;
  readonly executeTool: ExecuteTool;
  readonly hookInvoker: HookInvoker | undefined;
  readonly log: Logger;
  s2s: S2sHandle | null;
  pendingTools: PendingTool[];
  toolCallCount: number;
  turnPromise: Promise<void> | null;
  conversationMessages: Message[];
  /** Maximum number of messages to retain in conversationMessages. */
  readonly maxHistory: number;
  /** Monotonically increasing counter bumped on each reply_started. Tool calls
   *  capture the generation at start; finishToolCall only pushes to pendingTools
   *  if the generation still matches, preventing stale results from interrupted
   *  replies from leaking into subsequent replies. */
  replyGeneration: number;
  resolveTurnConfig(): Promise<{ maxSteps?: number; activeTools?: string[] } | null>;
  consumeToolCallStep(
    turnConfig: { maxSteps?: number; activeTools?: string[] } | null,
    name: string,
  ): string | null;
  fireHook(name: string, fn: (h: HookInvoker) => Promise<void>): void;
  /** Push one or more messages and trim to maxHistory. */
  pushMessages(...msgs: Message[]): void;
};

const DEFAULT_MAX_HISTORY = 200;

function buildCtx(opts: {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  hookInvoker: HookInvoker | undefined;
  log: Logger;
  maxHistory?: number | undefined;
}): S2sSessionCtx {
  const { id, agentConfig, hookInvoker, log } = opts;
  const maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  let cachedActiveTools: string[] | undefined;
  let cachedActiveSet: Set<string> | undefined;
  const ctx: S2sSessionCtx = {
    ...opts,
    s2s: null,
    pendingTools: [],
    toolCallCount: 0,
    turnPromise: null,
    conversationMessages: [],
    maxHistory,
    replyGeneration: 0,
    resolveTurnConfig() {
      if (!hookInvoker) return Promise.resolve(null);
      return hookInvoker.resolveTurnConfig(id, ctx.toolCallCount, HOOK_TIMEOUT_MS);
    },
    consumeToolCallStep(turnConfig, name) {
      const maxSteps = turnConfig?.maxSteps ?? agentConfig.maxSteps;
      ctx.toolCallCount++;
      if (maxSteps !== undefined && ctx.toolCallCount > maxSteps) {
        log.info("maxSteps exceeded, refusing tool call", {
          toolCallCount: ctx.toolCallCount,
          maxSteps,
        });
        return "Maximum tool steps reached. Please respond to the user now.";
      }
      if (turnConfig?.activeTools) {
        if (turnConfig.activeTools !== cachedActiveTools) {
          cachedActiveTools = turnConfig.activeTools;
          cachedActiveSet = new Set(turnConfig.activeTools);
        }
        if (!cachedActiveSet?.has(name)) {
          log.info("Tool filtered by activeTools", { name });
          return JSON.stringify({ error: `Tool "${name}" is not available at this step.` });
        }
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
    pushMessages(...msgs: Message[]) {
      ctx.conversationMessages.push(...msgs);
      if (maxHistory > 0 && ctx.conversationMessages.length > maxHistory) {
        ctx.conversationMessages = ctx.conversationMessages.slice(-maxHistory);
      }
    },
  };
  return ctx;
}

// ─── Main session factory ────────────────────────────────────────────────────

/** Create an S2S-backed session with the same interface as the STT+LLM+TTS session. */
export function createS2sSession(opts: S2sSessionOptions): Session {
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
  const ctx = buildCtx({
    id,
    agent,
    client,
    agentConfig,
    executeTool,
    hookInvoker,
    log,
    maxHistory: opts.maxHistory,
  });

  /** Monotonically increasing counter bumped on each connectAndSetup call.
   *  Only the most recent invocation is allowed to set ctx.s2s, preventing
   *  earlier completions from overwriting a newer connection during rapid resets. */
  let connectGeneration = 0;

  async function connectAndSetup(): Promise<void> {
    const generation = ++connectGeneration;
    try {
      const handle = await _internals.connectS2s({
        apiKey,
        config: s2sConfig,
        createWebSocket,
        logger: log,
      });
      // Guard against close() racing with start(): if the session was
      // stopped while we were connecting, close the handle immediately
      // to avoid an orphaned S2S connection.
      if (sessionAbort.signal.aborted) {
        handle.close();
        return;
      }
      // Guard against rapid resets: if a newer connectAndSetup was launched
      // while we were connecting, this invocation is stale — close the handle
      // to avoid an orphaned S2S connection.
      if (generation !== connectGeneration) {
        handle.close();
        return;
      }
      setupListeners(ctx, handle);
      handle.updateSession({
        systemPrompt,
        tools: s2sTools,
        ...(agentConfig.greeting ? { greeting: agentConfig.greeting } : {}),
      });
      ctx.s2s = handle;
    } catch (err: unknown) {
      const msg = errorMessage(err);
      log.error("S2S connect failed", { error: errorDetail(err) });
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
      ctx.replyGeneration++;
      ctx.s2s?.close();
      client.event({ type: "reset" });
      connectAndSetup().catch((err: unknown) =>
        log.error("S2S reset reconnect failed", { error: errorMessage(err) }),
      );
    },
    onHistory(incoming: readonly { role: "user" | "assistant"; text: string }[]): void {
      ctx.pushMessages(...fromWireMessages(incoming));
    },
    waitForTurn(): Promise<void> {
      return ctx.turnPromise ?? Promise.resolve();
    },
  };
}
