// Copyright 2025 the AAI authors. MIT license.
/** S2S session — relays audio between client and AssemblyAI S2S API. */

import type { AgentConfig, ExecuteTool, ToolSchema } from "./_internal-types.ts";
import { activeSessionsUpDown, sessionCounter, setupListeners } from "./_session-otel.ts";
import { errorDetail, errorMessage, toolError } from "./_utils.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_HISTORY, HOOK_TIMEOUT_MS } from "./constants.ts";
import type { AgentHookMap, AgentHooks } from "./hooks.ts";
import { callResolveTurnConfig } from "./hooks.ts";
import type { ClientSink } from "./protocol.ts";
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
import { idleTimeoutCounter } from "./telemetry.ts";
import type { Message } from "./types.ts";

export type { S2sHandle } from "./s2s.ts";

// ─── Session context (formerly _session-ctx.ts) ─────────────────────────────

type PendingTool = { callId: string; result: string };

/** Per-reply mutable state — reset on beginReply/cancelReply. */
export type ReplyState = {
  pendingTools: PendingTool[];
  toolCallCount: number;
  currentReplyId: string | null;
};

/** Immutable dependencies injected at session creation. */
export type SessionDeps = {
  readonly id: string;
  readonly agent: string;
  readonly client: ClientSink;
  readonly agentConfig: AgentConfig;
  readonly executeTool: ExecuteTool;
  readonly hooks: AgentHooks | undefined;
  readonly log: Logger;
  readonly maxHistory: number;
};

/**
 * Session context threaded through event handlers.
 *
 * Split into three layers:
 * - {@link SessionDeps} — immutable dependencies (set once)
 * - {@link ReplyState} via `reply` — per-reply mutable state (reset on beginReply/cancelReply)
 * - Remaining fields — connection, conversation, and lifecycle methods
 */
export type S2sSessionCtx = SessionDeps & {
  s2s: S2sHandle | null;
  reply: ReplyState;
  turnPromise: Promise<void> | null;
  conversationMessages: Message[];
  filterChain: Promise<void>;

  resolveTurnConfig(): Promise<{ maxSteps?: number } | null>;
  consumeToolCallStep(
    turnConfig: { maxSteps?: number } | null,
    name: string,
    replyId: string | null,
  ): string | null;
  fireHook(name: keyof AgentHookMap, ...args: unknown[]): void;
  drainHooks(): Promise<void>;
  pushMessages(...msgs: Message[]): void;
  beginReply(replyId: string): void;
  cancelReply(): void;
  chainTurn(p: Promise<void>): void;
};

export function buildCtx(opts: {
  id: string;
  agent: string;
  client: ClientSink;
  agentConfig: AgentConfig;
  executeTool: ExecuteTool;
  hooks: AgentHooks | undefined;
  log: Logger;
  maxHistory?: number | undefined;
}): S2sSessionCtx {
  const { id, agentConfig, hooks, log } = opts;
  const maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
  /** Track in-flight hook promises so they can be awaited during shutdown. */
  const pendingHooks = new Set<Promise<void>>();
  const ctx: S2sSessionCtx = {
    ...opts,
    s2s: null,
    reply: { pendingTools: [], toolCallCount: 0, currentReplyId: null },
    turnPromise: null,
    conversationMessages: [],
    maxHistory,
    filterChain: Promise.resolve(),
    resolveTurnConfig() {
      return callResolveTurnConfig(hooks, id, HOOK_TIMEOUT_MS);
    },
    consumeToolCallStep(turnConfig, _name, replyId) {
      if (replyId === null || replyId !== ctx.reply.currentReplyId) {
        return toolError("Reply was interrupted. Discarding stale tool call.");
      }
      const maxSteps = turnConfig?.maxSteps ?? agentConfig.maxSteps;
      ctx.reply.toolCallCount++;
      if (maxSteps !== undefined && ctx.reply.toolCallCount > maxSteps) {
        log.info("maxSteps exceeded, refusing tool call", {
          toolCallCount: ctx.reply.toolCallCount,
          maxSteps,
        });
        return toolError("Maximum tool steps reached. Please respond to the user now.");
      }
      return null;
    },
    fireHook(name, ...args) {
      if (!hooks) return;
      const notifyOnError = (err: unknown) => {
        log.warn(`${name} hook failed`, { err: errorMessage(err) });
        if (name !== "error") {
          const ep = hooks.callHook("error", id, { message: errorMessage(err) });
          if (ep && typeof (ep as Promise<void>).catch === "function") {
            (ep as Promise<void>).catch((e: unknown) => {
              log.warn("error hook failed", { err: errorMessage(e) });
            });
          }
        }
      };
      try {
        // biome-ignore lint/suspicious/noExplicitAny: hookable callHook is generic over hook args
        const result = (hooks.callHook as any)(name, ...args);
        // hookable returns undefined when no hooks are registered for the given name
        if (result == null) return;
        const p = result.catch(notifyOnError).finally(() => pendingHooks.delete(p));
        pendingHooks.add(p);
      } catch (err: unknown) {
        notifyOnError(err);
      }
    },
    async drainHooks() {
      if (pendingHooks.size > 0) await Promise.all([...pendingHooks]);
    },
    pushMessages(...msgs: Message[]) {
      ctx.conversationMessages.push(...msgs);
      if (maxHistory > 0 && ctx.conversationMessages.length > maxHistory) {
        ctx.conversationMessages = ctx.conversationMessages.slice(-maxHistory);
      }
    },
    beginReply(replyId: string) {
      ctx.reply = { pendingTools: [], toolCallCount: 0, currentReplyId: replyId };
      ctx.turnPromise = null;
      ctx.filterChain = Promise.resolve();
    },
    cancelReply() {
      ctx.reply = { pendingTools: [], toolCallCount: 0, currentReplyId: null };
      ctx.filterChain = Promise.resolve();
    },
    chainTurn(p: Promise<void>) {
      ctx.turnPromise = (ctx.turnPromise ?? Promise.resolve()).then(() => p);
    },
  };
  return ctx;
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export type { AgentHookMap, AgentHooks } from "./hooks.ts";
export {
  callBeforeTurn,
  callInterceptToolCall,
  callResolveTurnConfig,
  callTextHook,
  createAgentHooks,
} from "./hooks.ts";
export { buildSystemPrompt } from "./system-prompt.ts";

/**
 * A voice session managing the Speech-to-Speech connection for one client.
 *
 * Created by {@link createS2sSession}. Each session owns a single S2S WebSocket
 * connection and relays audio between the browser client and AssemblyAI.
 *
 * @internal Exported for use by `ws-handler.ts`, `server.ts`, and `direct-executor.ts`.
 */
export type Session = {
  start(): Promise<void>;
  stop(): Promise<void>;
  onAudio(data: Uint8Array): void;
  onAudioReady(): void;
  onCancel(): void;
  onReset(): void;
  onHistory(incoming: readonly { role: "user" | "assistant"; content: string }[]): void;
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
  hooks?: AgentHooks;
  skipGreeting?: boolean;
  logger?: Logger;
  maxHistory?: number;
};

/** @internal Not part of the public API. Exposed for testing only. */
export const _internals = { connectS2s };

type IdleTimer = { reset(): void; clear(): void };

function createIdleTimer(opts: {
  timeoutMs: number;
  agent: string;
  log: Logger;
  client: ClientSink;
  ctx: { s2s: { close(): void } | null };
}): IdleTimer {
  if (opts.timeoutMs <= 0) return { reset() {}, clear() {} };
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    reset() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        opts.log.info("S2S idle timeout", { timeoutMs: opts.timeoutMs, agent: opts.agent });
        idleTimeoutCounter.add(1, { agent: opts.agent });
        opts.client.event({ type: "idle_timeout" });
        opts.ctx.s2s?.close();
      }, opts.timeoutMs);
    },
    clear() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// ─── Main session factory ────────────────────────────────────────────────────

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
    hooks,
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
    hooks,
    log,
    maxHistory: opts.maxHistory,
  });

  const rawTimeout = agentConfig.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const idleMs = rawTimeout === 0 || !Number.isFinite(rawTimeout) ? 0 : rawTimeout;
  const idle = createIdleTimer({ timeoutMs: idleMs, agent, log, client, ctx });

  let connectGeneration = 0;
  const sessionUpdatePayload = {
    systemPrompt,
    tools: s2sTools,
    ...(agentConfig.greeting ? { greeting: agentConfig.greeting } : {}),
  };

  async function connectAndSetup(): Promise<void> {
    const generation = ++connectGeneration;
    try {
      const handle = await _internals.connectS2s({
        apiKey,
        config: s2sConfig,
        createWebSocket,
        logger: log,
      });
      if (sessionAbort.signal.aborted || generation !== connectGeneration) {
        handle.close();
        return;
      }
      setupListeners(ctx, handle);
      handle.updateSession(sessionUpdatePayload);
      ctx.s2s = handle;
      idle.reset();
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
      ctx.fireHook("connect", id, HOOK_TIMEOUT_MS);
      await connectAndSetup();
    },
    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      sessionAbort.abort();
      idle.clear();
      activeSessionsUpDown.add(-1, { agent });
      if (ctx.turnPromise !== null) await ctx.turnPromise;
      await ctx.drainHooks();
      ctx.s2s?.close();
      ctx.fireHook("disconnect", id, HOOK_TIMEOUT_MS);
      await ctx.drainHooks();
    },
    onAudio(data: Uint8Array): void {
      idle.reset();
      ctx.s2s?.sendAudio(data);
    },
    onAudioReady(): void {
      /* S2S greeting comes automatically */
    },
    onCancel(): void {
      client.event({ type: "cancelled" });
    },
    onReset(): void {
      ctx.cancelReply();
      ctx.conversationMessages = [];
      ctx.reply.toolCallCount = 0;
      ctx.turnPromise = null;
      idle.clear();
      ctx.s2s?.close();
      client.event({ type: "reset" });
      connectAndSetup().catch((err: unknown) =>
        log.error("S2S reset reconnect failed", { error: errorMessage(err) }),
      );
    },
    onHistory(incoming: readonly { role: "user" | "assistant"; content: string }[]): void {
      ctx.pushMessages(...incoming.map((m) => ({ role: m.role, content: m.content })));
    },
    waitForTurn(): Promise<void> {
      return ctx.turnPromise ?? Promise.resolve();
    },
  };
}
