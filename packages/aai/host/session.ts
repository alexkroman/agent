// Copyright 2025 the AAI authors. MIT license.
/** S2S session — relays audio between client and AssemblyAI S2S API. */

import { createActor, fromCallback, fromPromise, setup } from "xstate";
import type { AgentConfig, ExecuteTool, ToolSchema } from "../isolate/_internal-types.ts";
import { errorDetail, errorMessage, toolError } from "../isolate/_utils.ts";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_HISTORY,
  HOOK_TIMEOUT_MS,
  MAX_TOOL_RESULT_CHARS,
} from "../isolate/constants.ts";
import type { AgentHookMap, AgentHooks } from "../isolate/hooks.ts";
import { callResolveTurnConfig } from "../isolate/hooks.ts";
import type { ClientSink } from "../isolate/protocol.ts";
import { buildSystemPrompt } from "../isolate/system-prompt.ts";
import type { Message } from "../isolate/types.ts";
import type { Logger, S2SConfig } from "./runtime.ts";
import { consoleLogger } from "./runtime.ts";
import {
  type CreateS2sWebSocket,
  connectS2s,
  defaultCreateS2sWebSocket,
  type S2sHandle,
  type S2sToolCall,
  type S2sToolSchema,
} from "./s2s.ts";

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
    },
    cancelReply() {
      ctx.reply = { pendingTools: [], toolCallCount: 0, currentReplyId: null };
    },
    chainTurn(p: Promise<void>) {
      ctx.turnPromise = (ctx.turnPromise ?? Promise.resolve()).then(() => p);
    },
  };
  return ctx;
}

// ─── Re-exports ─────────────────────────────────────────────────────────────

export type { AgentHookMap, AgentHooks } from "../isolate/hooks.ts";
export { callResolveTurnConfig, createAgentHooks } from "../isolate/hooks.ts";
export { buildSystemPrompt } from "../isolate/system-prompt.ts";

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
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op timer
  if (opts.timeoutMs <= 0) return { reset() {}, clear() {} };
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    reset() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        opts.log.info("S2S idle timeout", { timeoutMs: opts.timeoutMs, agent: opts.agent });
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

// ─── Session event handlers ─────────────────────────────────────────────────

/**
 * Complete a tool call by truncating the result, emitting a `tool_call_done` event,
 * and accumulating the result in `ctx.reply.pendingTools` — but only if the reply that
 * initiated this call is still active.
 */
function finishToolCall(
  ctx: S2sSessionCtx,
  callId: string,
  result: string,
  replyId: string | null,
): void {
  const truncatedResult =
    result.length > MAX_TOOL_RESULT_CHARS ? result.slice(0, MAX_TOOL_RESULT_CHARS) : result;
  ctx.client.event({ type: "tool_call_done", toolCallId: callId, result: truncatedResult });
  if (replyId !== null && replyId === ctx.reply.currentReplyId) {
    ctx.reply.pendingTools.push({ callId, result });
    if (ctx.maxHistory > 0 && ctx.reply.pendingTools.length > ctx.maxHistory) {
      ctx.reply.pendingTools.shift();
    }
  }
}

async function handleToolCall(ctx: S2sSessionCtx, detail: S2sToolCall): Promise<void> {
  const { callId, name, args: parsedArgs } = detail;
  const replyId = ctx.reply.currentReplyId;

  ctx.client.event({
    type: "tool_call_start",
    toolCallId: callId,
    toolName: name,
    args: parsedArgs,
  });

  let turnConfig: { maxSteps?: number } | null;
  try {
    turnConfig = await ctx.resolveTurnConfig();
  } catch (err: unknown) {
    const msg = `resolveTurnConfig hook error: ${errorMessage(err)}`;
    ctx.log.error(msg);
    finishToolCall(ctx, callId, toolError(msg), replyId);
    return;
  }

  const refused = ctx.consumeToolCallStep(turnConfig, name, replyId);
  if (refused !== null) {
    finishToolCall(ctx, callId, refused, replyId);
    return;
  }

  ctx.log.info("S2S tool call", { tool: name, callId, args: parsedArgs, agent: ctx.agent });

  let result: string;
  try {
    result = await ctx.executeTool(name, parsedArgs, ctx.id, ctx.conversationMessages);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    ctx.log.error("Tool execution failed", { tool: name, error: errorDetail(err) });
    result = toolError(msg);
  }

  ctx.log.info("S2S tool result", { tool: name, callId, resultLength: result.length });
  finishToolCall(ctx, callId, result, replyId);
}

function handleUserTranscript(ctx: S2sSessionCtx, text: string): void {
  ctx.log.info("S2S user transcript", { text });
  ctx.client.event({ type: "transcript", text, isFinal: true });
  ctx.client.event({ type: "turn", text });
  ctx.pushMessages({ role: "user", content: text });
  ctx.fireHook("turn", ctx.id, text, HOOK_TIMEOUT_MS);
}

function handleAgentTranscript(ctx: S2sSessionCtx, text: string, interrupted: boolean): void {
  ctx.client.event({ type: "chat", text });
  if (!interrupted) {
    ctx.pushMessages({ role: "assistant", content: text });
  }
}

function sendPendingToolResults(ctx: S2sSessionCtx): void {
  const doneReplyId = ctx.reply.currentReplyId;
  const doSend = () => {
    if (ctx.reply.currentReplyId !== doneReplyId) {
      ctx.reply.pendingTools = [];
      return;
    }
    if (ctx.reply.pendingTools.length > 0) {
      for (const tool of ctx.reply.pendingTools) ctx.s2s?.sendToolResult(tool.callId, tool.result);
      ctx.reply.pendingTools = [];
    } else {
      const stepsUsed = ctx.reply.toolCallCount;
      if (stepsUsed > 0) {
        ctx.log.info("Turn complete", { steps: stepsUsed, agent: ctx.agent });
      }
      ctx.client.playAudioDone();
      ctx.client.event({ type: "tts_done" });
    }
  };
  if (ctx.turnPromise !== null) {
    void ctx.turnPromise.then(doSend);
  } else {
    doSend();
  }
}

// ─── XState machine events ─────────────────────────────────────────────────

type SessionMachineEvent =
  | { type: "START" }
  | { type: "STOP" }
  | { type: "RESET" }
  | { type: "SEND_AUDIO"; data: Uint8Array }
  | { type: "CANCEL" }
  | { type: "HISTORY"; messages: readonly { role: "user" | "assistant"; content: string }[] }
  | { type: "S2S_READY"; sessionId: string }
  | { type: "S2S_SESSION_EXPIRED" }
  | { type: "S2S_SPEECH_STARTED" }
  | { type: "S2S_SPEECH_STOPPED" }
  | { type: "S2S_USER_TRANSCRIPT_DELTA"; text: string }
  | { type: "S2S_USER_TRANSCRIPT"; itemId: string; text: string }
  | { type: "S2S_REPLY_STARTED"; replyId: string }
  | { type: "S2S_AUDIO"; audio: Uint8Array }
  | { type: "S2S_AGENT_TRANSCRIPT_DELTA"; text: string }
  | { type: "S2S_AGENT_TRANSCRIPT"; text: string; interrupted: boolean }
  | { type: "S2S_TOOL_CALL"; detail: S2sToolCall }
  | { type: "S2S_REPLY_DONE"; status?: string }
  | { type: "S2S_ERROR"; code: string; message: string }
  | { type: "S2S_CLOSE" };

// ─── XState machine ────────────────────────────────────────────────────────

type SessionMachineContext = {
  ctx: S2sSessionCtx;
  idle: IdleTimer;
  sessionAbort: AbortController;
  connectOpts: {
    apiKey: string;
    s2sConfig: S2SConfig;
    createWebSocket: CreateS2sWebSocket;
    log: Logger;
  };
  sessionUpdatePayload: {
    systemPrompt: string;
    tools: S2sToolSchema[];
    greeting?: string;
  };
  getConnectGeneration: () => number;
  incrementConnectGeneration: () => number;
};

const sessionMachine = setup({
  types: {
    context: {} as SessionMachineContext,
    events: {} as SessionMachineEvent,
    input: {} as SessionMachineContext,
  },
  actors: {
    /** Connect to S2S and return the handle. Tracks generation to close stale connections. */
    connect: fromPromise(
      async ({
        input,
      }: {
        input: SessionMachineContext["connectOpts"] & {
          generation: number;
          getConnectGeneration: () => number;
        };
      }) => {
        const handle = await _internals.connectS2s({
          apiKey: input.apiKey,
          config: input.s2sConfig,
          createWebSocket: input.createWebSocket,
          logger: input.log,
        });
        // If a newer connect was started while we were awaiting, close this stale handle.
        if (input.generation !== input.getConnectGeneration()) {
          handle.close();
          throw new Error("Connection superseded by newer attempt");
        }
        return handle;
      },
    ),
    /** Bridge S2S handle events to machine events via `sendBack`. */
    s2sListener: fromCallback<SessionMachineEvent, { handle: S2sHandle; ctx: S2sSessionCtx }>(
      ({ sendBack, input: { handle, ctx } }) => {
        handle.on("ready", ({ sessionId }) => {
          ctx.log.info("S2S session ready", { sessionId });
          sendBack({ type: "S2S_READY", sessionId });
        });
        handle.on("sessionExpired", () => sendBack({ type: "S2S_SESSION_EXPIRED" }));
        handle.on("speechStarted", () => sendBack({ type: "S2S_SPEECH_STARTED" }));
        handle.on("speechStopped", () => sendBack({ type: "S2S_SPEECH_STOPPED" }));
        handle.on("userTranscriptDelta", ({ text }) =>
          sendBack({ type: "S2S_USER_TRANSCRIPT_DELTA", text }),
        );
        handle.on("userTranscript", ({ itemId, text }) =>
          sendBack({ type: "S2S_USER_TRANSCRIPT", itemId, text }),
        );
        handle.on("replyStarted", ({ replyId }) =>
          sendBack({ type: "S2S_REPLY_STARTED", replyId }),
        );
        handle.on("audio", ({ audio }) => sendBack({ type: "S2S_AUDIO", audio }));
        handle.on("agentTranscriptDelta", ({ text }) =>
          sendBack({ type: "S2S_AGENT_TRANSCRIPT_DELTA", text }),
        );
        handle.on("agentTranscript", ({ text, interrupted }) =>
          sendBack({ type: "S2S_AGENT_TRANSCRIPT", text, interrupted }),
        );
        handle.on("toolCall", (detail) => sendBack({ type: "S2S_TOOL_CALL", detail }));
        handle.on("replyDone", ({ status }) => sendBack({ type: "S2S_REPLY_DONE", status }));
        handle.on("error", ({ code, message }) => sendBack({ type: "S2S_ERROR", code, message }));
        handle.on("close", () => sendBack({ type: "S2S_CLOSE" }));
      },
    ),
  },
}).createMachine({
  id: "session",
  initial: "disconnected",
  context: ({ input }) => input,

  states: {
    // ─── Disconnected ────────────────────────────────────────────────
    disconnected: {
      on: {
        START: {
          target: "connecting",
          actions: ({ context }) =>
            context.ctx.fireHook("connect", context.ctx.id, HOOK_TIMEOUT_MS),
        },
      },
    },

    // ─── Connecting (invoke auto-cancels on exit) ────────────────────
    connecting: {
      entry: ({ context }) => {
        context.incrementConnectGeneration();
      },
      invoke: {
        src: "connect",
        input: ({ context }) => ({
          ...context.connectOpts,
          generation: context.getConnectGeneration(),
          getConnectGeneration: context.getConnectGeneration,
        }),
        onDone: {
          target: "connected",
          actions: ({ context, event }) => {
            const handle = event.output;
            context.ctx.s2s = handle;
            handle.updateSession(context.sessionUpdatePayload);
            context.idle.reset();
          },
        },
        onError: {
          target: "disconnected",
          actions: ({ context, event }) => {
            // "Connection superseded" errors are expected during rapid resets
            if (event.error instanceof Error && event.error.message.includes("superseded")) return;
            const msg = errorMessage(event.error);
            context.ctx.log.error("S2S connect failed", { error: errorDetail(event.error) });
            context.ctx.client.event({ type: "error", code: "internal", message: msg });
          },
        },
      },
      // RESET during connecting: re-enter to start a fresh connection
      on: {
        RESET: {
          target: "connecting",
          reenter: true,
          actions: ({ context }) => {
            context.ctx.cancelReply();
            context.ctx.conversationMessages = [];
            context.ctx.reply.toolCallCount = 0;
            context.ctx.turnPromise = null;
            context.idle.clear();
            context.ctx.s2s?.close();
            context.ctx.client.event({ type: "reset" });
          },
        },
      },
    },

    // ─── Connected (S2S handle active) ───────────────────────────────
    connected: {
      initial: "idle",

      // Bridge S2S handle events into the machine while connected.
      invoke: {
        src: "s2sListener",
        // biome-ignore lint/style/noNonNullAssertion: s2s is always set when entering connected state
        input: ({ context }) => ({ handle: context.ctx.s2s!, ctx: context.ctx }),
      },

      // Events handled in any connected substate
      on: {
        SEND_AUDIO: {
          actions: ({ context, event }) => {
            context.idle.reset();
            context.ctx.s2s?.sendAudio(event.data);
          },
        },
        S2S_SPEECH_STARTED: {
          actions: ({ context }) => context.ctx.client.event({ type: "speech_started" }),
        },
        S2S_SPEECH_STOPPED: {
          actions: ({ context }) => context.ctx.client.event({ type: "speech_stopped" }),
        },
        S2S_USER_TRANSCRIPT_DELTA: {
          actions: ({ context, event }) =>
            context.ctx.client.event({ type: "transcript", text: event.text, isFinal: false }),
        },
        S2S_USER_TRANSCRIPT: {
          actions: ({ context, event }) => handleUserTranscript(context.ctx, event.text),
        },
        S2S_AUDIO: {
          actions: ({ context, event }) => context.ctx.client.playAudioChunk(event.audio),
        },
        S2S_AGENT_TRANSCRIPT_DELTA: {
          actions: ({ context, event }) =>
            context.ctx.client.event({ type: "chat_delta", text: event.text }),
        },
        S2S_AGENT_TRANSCRIPT: {
          actions: ({ context, event }) =>
            handleAgentTranscript(context.ctx, event.text, event.interrupted),
        },
        S2S_SESSION_EXPIRED: {
          target: "disconnected",
          actions: ({ context }) => {
            context.ctx.log.info("S2S session expired");
            context.ctx.s2s?.close();
          },
        },
        S2S_ERROR: {
          target: "disconnected",
          actions: ({ context, event }) => {
            context.ctx.log.error("S2S error", { code: event.code, message: event.message });
            context.ctx.client.event({ type: "error", code: "internal", message: event.message });
            context.ctx.s2s?.close();
          },
        },
        S2S_CLOSE: {
          target: "disconnected",
          actions: ({ context }) => {
            context.ctx.log.info("S2S closed");
            context.ctx.s2s = null;
            context.ctx.cancelReply();
          },
        },
        RESET: {
          target: "connecting",
          actions: ({ context }) => {
            context.ctx.cancelReply();
            context.ctx.conversationMessages = [];
            context.ctx.reply.toolCallCount = 0;
            context.ctx.turnPromise = null;
            context.idle.clear();
            context.ctx.s2s?.close();
            context.ctx.client.event({ type: "reset" });
          },
        },
        CANCEL: {
          actions: ({ context }) => context.ctx.client.event({ type: "cancelled" }),
        },
        HISTORY: {
          actions: ({ context, event }) =>
            context.ctx.pushMessages(
              ...event.messages.map((m) => ({ role: m.role, content: m.content })),
            ),
        },
      },

      states: {
        // ─── Idle: waiting for a reply ─────────────────────────
        idle: {
          on: {
            S2S_REPLY_STARTED: {
              target: "replying",
              actions: ({ context, event }) => context.ctx.beginReply(event.replyId),
            },
            S2S_REPLY_DONE: [
              {
                guard: ({ event }) => event.status === "interrupted",
                actions: ({ context }) => {
                  context.ctx.log.info("S2S reply interrupted (barge-in)");
                  context.ctx.cancelReply();
                  context.ctx.client.event({ type: "cancelled" });
                },
              },
              {
                actions: ({ context }) => sendPendingToolResults(context.ctx),
              },
            ],
          },
        },

        // ─── Replying: processing a reply from S2S ────────────
        replying: {
          on: {
            S2S_TOOL_CALL: {
              actions: ({ context, event }) => {
                const p = handleToolCall(context.ctx, event.detail).catch((err: unknown) => {
                  context.ctx.log.error("Tool call handler failed", {
                    err: errorMessage(err),
                  });
                });
                context.ctx.chainTurn(p);
              },
            },
            S2S_REPLY_DONE: [
              {
                guard: ({ event }) => event.status === "interrupted",
                target: "idle",
                actions: ({ context }) => {
                  context.ctx.log.info("S2S reply interrupted (barge-in)");
                  context.ctx.cancelReply();
                  context.ctx.client.event({ type: "cancelled" });
                },
              },
              {
                target: "idle",
                actions: ({ context }) => sendPendingToolResults(context.ctx),
              },
            ],
            // A new reply can start while previous is still active
            S2S_REPLY_STARTED: {
              actions: ({ context, event }) => context.ctx.beginReply(event.replyId),
            },
          },
        },
      },
    },

    // ─── Stopped (final) ─────────────────────────────────────────────
    stopped: {
      type: "final",
    },
  },

  // Global events (any state)
  on: {
    STOP: {
      target: ".stopped",
      actions: ({ context }) => context.incrementConnectGeneration(),
    },
  },
});

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

  const sessionUpdatePayload = {
    systemPrompt,
    tools: s2sTools,
    ...(agentConfig.greeting ? { greeting: agentConfig.greeting } : {}),
  };

  let connectGeneration = 0;

  const actor = createActor(sessionMachine, {
    input: {
      ctx,
      idle,
      sessionAbort: new AbortController(),
      connectOpts: { apiKey, s2sConfig, createWebSocket, log },
      sessionUpdatePayload,
      getConnectGeneration: () => connectGeneration,
      incrementConnectGeneration: () => ++connectGeneration,
    },
  });
  actor.start();

  let stopped = false;

  return {
    async start(): Promise<void> {
      actor.send({ type: "START" });
      // Wait for the connection attempt to finish (success, error, or stop).
      await new Promise<void>((resolve) => {
        const sub = actor.subscribe((snapshot) => {
          const state = snapshot.value;
          if (state !== "connecting") {
            sub.unsubscribe();
            resolve();
          }
        });
      });
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      idle.clear();
      if (ctx.turnPromise !== null) await ctx.turnPromise;
      await ctx.drainHooks();
      ctx.s2s?.close();
      actor.send({ type: "STOP" });
      ctx.fireHook("disconnect", ctx.id, HOOK_TIMEOUT_MS);
      await ctx.drainHooks();
    },

    onAudio(data: Uint8Array): void {
      actor.send({ type: "SEND_AUDIO", data });
    },

    onAudioReady(): void {
      /* S2S greeting comes automatically */
    },

    onCancel(): void {
      actor.send({ type: "CANCEL" });
    },

    onReset(): void {
      actor.send({ type: "RESET" });
    },

    onHistory(incoming: readonly { role: "user" | "assistant"; content: string }[]): void {
      actor.send({ type: "HISTORY", messages: incoming });
    },

    waitForTurn(): Promise<void> {
      return ctx.turnPromise ?? Promise.resolve();
    },
  };
}
