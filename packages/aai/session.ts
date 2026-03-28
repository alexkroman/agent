// Copyright 2025 the AAI authors. MIT license.
/** S2S session — relays audio between client and AssemblyAI S2S API. */

import type { AgentConfig, ToolSchema } from "./_internal-types.ts";
import { activeSessionsUpDown, sessionCounter, setupListeners } from "./_session-otel.ts";
import { errorDetail, errorMessage, toolError } from "./_utils.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_HISTORY, HOOK_TIMEOUT_MS } from "./constants.ts";
import type { HookInvoker } from "./middleware.ts";
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
import type { ExecuteTool } from "./worker-entry.ts";

export type { S2sHandle } from "./s2s.ts";

// ─── Session context (formerly _session-ctx.ts) ─────────────────────────────

type PendingTool = { callId: string; result: string };

/**
 * Mutable state and dependencies shared across session helper functions.
 *
 * Created once per session by `buildCtx` and threaded through `setupListeners`,
 * `handleToolCall`, and other internal helpers. Contains both immutable
 * dependencies (logger, executor) and mutable per-turn state (pending tools,
 * generation counters).
 */
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
  /** The `reply_id` from the most recent `reply.started` event. Tool calls
   *  capture this at start; finishToolCall only pushes to pendingTools if the
   *  reply ID still matches, preventing stale results from interrupted replies
   *  from leaking into subsequent replies. Set to `null` on close/reset. */
  currentReplyId: string | null;
  /** Resolve per-turn configuration (dynamic `maxSteps`). */
  resolveTurnConfig(): Promise<{ maxSteps?: number } | null>;
  /** Increment the tool call counter and check whether the call should be refused. */
  consumeToolCallStep(
    turnConfig: { maxSteps?: number } | null,
    name: string,
    replyId: string | null,
  ): string | null;
  /** Fire a lifecycle hook asynchronously. Errors are logged but never propagated. */
  fireHook(name: string, fn: (h: HookInvoker) => Promise<void>): void;
  /** Await all in-flight hook promises. Used during shutdown. */
  drainHooks(): Promise<void>;
  /** Push one or more messages and trim to maxHistory. */
  pushMessages(...msgs: Message[]): void;
  /** Sequential promise chain for filterOutput calls, ensuring ordering. */
  filterChain: Promise<void>;

  // ── State transition methods ──────────────────────────────────────
  // Per-reply mutable state (pendingTools, toolCallCount, currentReplyId,
  // turnPromise, filterChain) is modified from multiple event handlers.
  // These methods centralise the resets so fields stay in sync.

  /** Reset per-reply state for a new reply from the S2S API. */
  beginReply(replyId: string): void;
  /** Invalidate the current reply (barge-in, close, or reset). */
  cancelReply(): void;
  /** Append a tool-call promise to the turn promise chain. */
  chainTurn(p: Promise<void>): void;
};

export function buildCtx(opts: {
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
  /** Track in-flight hook promises so they can be awaited during shutdown. */
  const pendingHooks = new Set<Promise<void>>();
  const ctx: S2sSessionCtx = {
    ...opts,
    s2s: null,
    pendingTools: [],
    toolCallCount: 0,
    turnPromise: null,
    conversationMessages: [],
    maxHistory,
    currentReplyId: null,
    filterChain: Promise.resolve(),
    resolveTurnConfig() {
      if (!hookInvoker) return Promise.resolve(null);
      return hookInvoker.resolveTurnConfig(id, HOOK_TIMEOUT_MS);
    },
    consumeToolCallStep(turnConfig, _name, replyId) {
      // Guard: ignore tool calls from a stale reply (interrupted or closed).
      if (replyId === null || replyId !== ctx.currentReplyId) {
        return toolError("Reply was interrupted. Discarding stale tool call.");
      }
      const maxSteps = turnConfig?.maxSteps ?? agentConfig.maxSteps;
      ctx.toolCallCount++;
      if (maxSteps !== undefined && ctx.toolCallCount > maxSteps) {
        log.info("maxSteps exceeded, refusing tool call", {
          toolCallCount: ctx.toolCallCount,
          maxSteps,
        });
        return toolError("Maximum tool steps reached. Please respond to the user now.");
      }
      return null;
    },
    fireHook(name, fn) {
      if (!hookInvoker) return;
      const notifyOnError = (err: unknown) => {
        log.warn(`${name} hook failed`, { err: errorMessage(err) });
        if (name !== "onError") {
          try {
            const r = hookInvoker.onError(id, { message: errorMessage(err) });
            if (r && typeof r.catch === "function") {
              r.catch((e: unknown) => {
                log.warn("onError hook failed", { err: errorMessage(e) });
              });
            }
          } catch (e: unknown) {
            log.warn("onError hook failed", { err: errorMessage(e) });
          }
        }
      };
      try {
        const p = fn(hookInvoker)
          .catch(notifyOnError)
          .finally(() => pendingHooks.delete(p));
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
      ctx.toolCallCount = 0;
      ctx.currentReplyId = replyId;
      ctx.pendingTools = [];
      ctx.turnPromise = null;
      ctx.filterChain = Promise.resolve();
    },
    cancelReply() {
      ctx.currentReplyId = null;
      ctx.pendingTools = [];
      ctx.filterChain = Promise.resolve();
    },
    chainTurn(p: Promise<void>) {
      ctx.turnPromise = (ctx.turnPromise ?? Promise.resolve()).then(() => p);
    },
  };
  return ctx;
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export type {
  HookInvoker,
  LifecycleHooks,
  MiddlewareRunner,
  ToolInterceptResult,
} from "./middleware.ts";
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
  /** Open the S2S connection and fire the `onConnect` hook. */
  start(): Promise<void>;
  /** Gracefully shut down: wait for in-flight turns, close the S2S socket, fire `onDisconnect`. */
  stop(): Promise<void>;
  /** Forward raw PCM audio from the client microphone to the S2S connection. */
  onAudio(data: Uint8Array): void;
  /** Called when the client has finished setting up its audio pipeline. For S2S sessions this is a no-op since the greeting comes automatically. */
  onAudioReady(): void;
  /** Handle a client-initiated cancellation (barge-in). Sends a `cancelled` event. */
  onCancel(): void;
  /** Reset the session: clear conversation history, bump generation counters, reconnect S2S. */
  onReset(): void;
  /**
   * Inject conversation history from the client (e.g. on reconnect).
   * @param incoming - Messages with `{role, content}` fields.
   */
  onHistory(incoming: readonly { role: "user" | "assistant"; content: string }[]): void;
  /** Returns a promise that resolves when the current in-flight turn completes, or resolves immediately if no turn is active. */
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

type IdleTimer = { reset(): void; clear(): void };

function createIdleTimer(opts: {
  timeoutMs: number;
  agent: string;
  log: Logger;
  client: ClientSink;
  ctx: { s2s: { close(): void } | null };
}): IdleTimer {
  if (opts.timeoutMs <= 0)
    return {
      reset() {
        /* no-op: idle timeout disabled */
      },
      clear() {
        /* no-op: idle timeout disabled */
      },
    };
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

/**
 * Create a Speech-to-Speech backed session implementing the {@link Session} interface.
 *
 * Connects to AssemblyAI's S2S WebSocket, configures the system prompt and tools,
 * and wires up event listeners for user transcripts, agent replies, tool calls,
 * barge-ins, and session lifecycle. Manages reconnection on `onReset` via a
 * `connectGeneration` guard that prevents stale connection attempts from overwriting
 * newer ones during rapid resets. A `sessionAbort` AbortController is used to
 * coordinate cleanup on `stop()`.
 *
 * @param opts - Session configuration. See {@link S2sSessionOptions} for all fields
 *   including the agent config, tool schemas, API key, and optional hooks.
 * @returns A {@link Session} with `start`, `stop`, `onAudio`, `onReset`, and other
 *   lifecycle methods.
 */
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

  const rawTimeout = agentConfig.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const idleMs = rawTimeout === 0 || !Number.isFinite(rawTimeout) ? 0 : rawTimeout;
  const idle = createIdleTimer({ timeoutMs: idleMs, agent, log, client, ctx });

  /** Monotonically increasing counter bumped on each connectAndSetup call.
   *  Only the most recent invocation is allowed to set ctx.s2s, preventing
   *  earlier completions from overwriting a newer connection during rapid resets. */
  let connectGeneration = 0;

  /** The session.update payload shared by fresh and fallback paths. */
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
      // Stale if session was stopped or a newer connectAndSetup was launched.
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
      ctx.fireHook("onConnect", (h) => h.onConnect(id, HOOK_TIMEOUT_MS));
      await connectAndSetup();
    },
    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      sessionAbort.abort();
      idle.clear();
      activeSessionsUpDown.add(-1, { agent });
      if (ctx.turnPromise !== null) await ctx.turnPromise;
      // Drain in-flight hooks (onTurn, etc.) BEFORE closing
      // the S2S connection so they don't send on a closed socket.
      await ctx.drainHooks();
      ctx.s2s?.close();
      ctx.fireHook("onDisconnect", (h) => h.onDisconnect(id, HOOK_TIMEOUT_MS));
      // Drain again for the onDisconnect hook we just fired.
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
      ctx.toolCallCount = 0;
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
