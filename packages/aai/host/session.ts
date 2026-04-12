// Copyright 2025 the AAI authors. MIT license.
/** S2S session — relays audio between client and AssemblyAI S2S API. */

import type { AgentConfig, ExecuteTool, ToolSchema } from "../sdk/_internal-types.ts";
import { errorDetail, errorMessage, toolError } from "../sdk/_utils.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, MAX_TOOL_RESULT_CHARS } from "../sdk/constants.ts";
import type { ClientEvent, ClientSink } from "../sdk/protocol.ts";
import { buildSystemPrompt } from "../sdk/system-prompt.ts";
import type { Logger, S2SConfig } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import {
  type CreateS2sWebSocket,
  connectS2s,
  defaultCreateS2sWebSocket,
  type S2sHandle,
  type S2sToolSchema,
} from "./s2s.ts";
import { buildCtx, type S2sSessionCtx } from "./session-ctx.ts";

export type { S2sHandle } from "./s2s.ts";
export type { ReplyState, S2sSessionCtx, SessionDeps } from "./session-ctx.ts";
export { buildCtx } from "./session-ctx.ts";

/**
 * A voice session managing the Speech-to-Speech connection for one client.
 *
 * Created by {@link createS2sSession}. Each session owns a single S2S WebSocket
 * connection and relays audio between the browser client and AssemblyAI.
 *
 * @internal Exported for use by `ws-handler.ts`, `server.ts`, and `runtime.ts`.
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

/** Configuration options for creating a new S2S voice session. */
export type S2sSessionOptions = {
  /** Unique session identifier (used for KV scoping and logging). */
  id: string;
  /** Agent slug — identifies which deployed agent this session belongs to. */
  agent: string;
  /** Sink for pushing events and audio to the connected browser client. */
  client: ClientSink;
  /** Serializable agent config (name, system prompt, greeting, maxSteps, etc.). */
  agentConfig: AgentConfig;
  /** JSON Schema definitions for the agent's custom tools. */
  toolSchemas: readonly ToolSchema[];
  /** Optional natural-language guidance appended to the system prompt for tool usage. */
  toolGuidance?: readonly string[];
  /** AssemblyAI API key — stays host-side, never forwarded to the guest sandbox. */
  apiKey: string;
  /** S2S connection config (sample rates, model selection). */
  s2sConfig: S2SConfig;
  /** Function to invoke tools by name (wired to direct-executor or sandbox RPC). */
  executeTool: ExecuteTool;
  /** Override WebSocket constructor for testing. */
  createWebSocket?: CreateS2sWebSocket;
  /** Agent environment variables (secrets). Forwarded to tool context. */
  env?: Record<string, string | undefined>;
  /** Skip the initial greeting audio on connect (used for session resume). */
  skipGreeting?: boolean;
  /** Logger instance. Defaults to `consoleLogger`. */
  logger?: Logger;
  /** Max conversation messages to retain. Defaults to DEFAULT_MAX_HISTORY (200). */
  maxHistory?: number;
};

/** @internal Not part of the public API. Exposed for testing only. */
export const _internals = { connectS2s };

type IdleTimer = { reset(): void; clear(): void };

/**
 * Create an idle timer that closes the S2S connection after inactivity.
 * Convention: `timeoutMs <= 0` disables the timer entirely (returns a no-op).
 * This allows agents to opt out of idle timeout via `idleTimeoutMs: 0` in their config.
 */
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

async function handleToolCall(
  ctx: S2sSessionCtx,
  event: Extract<ClientEvent, { type: "tool_call" }>,
): Promise<void> {
  const { toolCallId: callId, toolName: name, args: parsedArgs } = event;
  const replyId = ctx.reply.currentReplyId;

  ctx.client.event(event);

  const refused = ctx.consumeToolCallStep(name, replyId);
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
  ctx.client.event({ type: "user_transcript", text });
  ctx.pushMessages({ role: "user", content: text });
}

function handleAgentTranscript(ctx: S2sSessionCtx, text: string, interrupted: boolean): void {
  ctx.client.event({ type: "agent_transcript", text });
  if (!interrupted) {
    ctx.pushMessages({ role: "assistant", content: text });
  }
}

function handleReplyCancelled(ctx: S2sSessionCtx): void {
  ctx.log.info("S2S reply interrupted (barge-in)");
  ctx.cancelReply();
  ctx.client.event({ type: "cancelled" });
}

function handleReplyDone(ctx: S2sSessionCtx): void {
  const doneReplyId = ctx.reply.currentReplyId;
  const sendPending = () => {
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
      ctx.client.event({ type: "reply_done" });
    }
  };
  if (ctx.turnPromise !== null) {
    void ctx.turnPromise.then(sendPending);
  } else {
    sendPending();
  }
}

function setupListeners(ctx: S2sSessionCtx, handle: S2sHandle): void {
  handle.on("ready", ({ sessionId }) => ctx.log.info("S2S session ready", { sessionId }));
  handle.on("replyStarted", ({ replyId }) => {
    ctx.beginReply(replyId);
  });
  handle.on("sessionExpired", () => {
    ctx.log.info("S2S session expired");
    handle.close();
  });
  handle.on("audio", ({ audio }) => ctx.client.playAudioChunk(audio));
  handle.on("error", (err) => {
    ctx.log.error("S2S error", { message: err.message });
    ctx.client.event({ type: "error", code: "internal", message: err.message });
    handle.close();
  });
  handle.on("close", (code, reason) => {
    ctx.log.info("S2S closed", { code, reason });
    ctx.s2s = null;
    ctx.cancelReply();
  });

  handle.on("event", (event) => {
    switch (event.type) {
      case "user_transcript":
        handleUserTranscript(ctx, event.text);
        break;
      case "agent_transcript":
        handleAgentTranscript(ctx, event.text, event._interrupted ?? false);
        break;
      case "tool_call": {
        const p = handleToolCall(ctx, event).catch((err: unknown) => {
          ctx.log.error("Tool call handler failed", { err: errorMessage(err) });
        });
        ctx.chainTurn(p);
        break;
      }
      case "reply_done":
        handleReplyDone(ctx);
        break;
      case "cancelled":
        handleReplyCancelled(ctx);
        break;
      default:
        ctx.client.event(event);
    }
  });
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
    logger: log = consoleLogger,
  } = opts;
  const agentConfig = opts.skipGreeting ? { ...opts.agentConfig, greeting: "" } : opts.agentConfig;
  const hasTools = toolSchemas.length > 0 || (agentConfig.builtinTools?.length ?? 0) > 0;
  const systemPrompt = buildSystemPrompt(agentConfig, {
    hasTools,
    voice: true,
    toolGuidance: opts.toolGuidance,
  });
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
      await connectAndSetup();
    },
    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      sessionAbort.abort();
      idle.clear();
      if (ctx.turnPromise !== null) await ctx.turnPromise;
      ctx.s2s?.close();
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
