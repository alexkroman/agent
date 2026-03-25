// Copyright 2025 the AAI authors. MIT license.
/**
 * S2S session — relays audio between the client and AssemblyAI's
 * Speech-to-Speech API, intercepting only tool calls for local execution.
 */

import type { AgentConfig, ToolSchema } from "./_internal-types.ts";
import { errorMessage } from "./_utils.ts";
import type { ClientSink } from "./protocol.ts";
import { fromWireMessages, HOOK_TIMEOUT_MS, MAX_TOOL_RESULT_CHARS } from "./protocol.ts";
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
import { buildSystemPrompt } from "./system-prompt.ts";
import {
  activeSessionsUpDown,
  bargeInCounter,
  sessionCounter,
  toolCallCounter,
  toolCallDuration,
  toolCallErrorCounter,
  tracer,
  turnCounter,
} from "./telemetry.ts";
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

// ─── Session context & extracted helpers ─────────────────────────────────────

type PendingTool = { call_id: string; result: string };

/** Mutable state + dependencies shared across session helper functions. */
type S2sSessionCtx = {
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
};

function resolveTurnConfig(
  ctx: S2sSessionCtx,
): Promise<{ maxSteps?: number; activeTools?: string[] } | null> {
  if (!ctx.hookInvoker) return Promise.resolve(null);
  return ctx.hookInvoker.resolveTurnConfig(ctx.id, ctx.toolCallCount, HOOK_TIMEOUT_MS);
}

function fireHook(ctx: S2sSessionCtx, name: string, fn: (h: HookInvoker) => Promise<void>): void {
  if (!ctx.hookInvoker) return;
  try {
    fn(ctx.hookInvoker).catch((err: unknown) => {
      ctx.log.warn(`${name} hook failed`, { err: errorMessage(err) });
    });
  } catch (err: unknown) {
    ctx.log.warn(`${name} hook failed`, { err: errorMessage(err) });
  }
}

function checkTurnLimits(
  ctx: S2sSessionCtx,
  turnConfig: { maxSteps?: number; activeTools?: string[] } | null,
  name: string,
): string | null {
  const maxSteps = turnConfig?.maxSteps ?? ctx.agentConfig.maxSteps;
  ctx.toolCallCount++;

  if (maxSteps !== undefined && ctx.toolCallCount > maxSteps) {
    ctx.log.info("maxSteps exceeded, refusing tool call", {
      toolCallCount: ctx.toolCallCount,
      maxSteps,
    });
    return "Maximum tool steps reached. Please respond to the user now.";
  }

  if (turnConfig?.activeTools && !turnConfig.activeTools.includes(name)) {
    ctx.log.info("Tool filtered by activeTools", { name });
    return JSON.stringify({ error: `Tool "${name}" is not available at this step.` });
  }

  return null;
}

function finishToolCall(ctx: S2sSessionCtx, call_id: string, result: string): void {
  ctx.pendingTools.push({ call_id, result });
  const truncatedResult =
    result.length > MAX_TOOL_RESULT_CHARS ? result.slice(0, MAX_TOOL_RESULT_CHARS) : result;
  ctx.client.event({ type: "tool_call_done", toolCallId: call_id, result: truncatedResult });
}

async function handleToolCall(ctx: S2sSessionCtx, detail: S2sToolCall): Promise<void> {
  const { call_id, name, args: parsedArgs } = detail;
  const span = tracer.startSpan("tool.call", {
    attributes: {
      "aai.tool.name": name,
      "aai.tool.call_id": call_id,
      "aai.agent": ctx.agent,
      "aai.session.id": ctx.id,
    },
  });
  const startTime = performance.now();

  ctx.client.event({
    type: "tool_call_start",
    toolCallId: call_id,
    toolName: name,
    args: parsedArgs,
  });

  let turnConfig: { maxSteps?: number; activeTools?: string[] } | null;
  try {
    turnConfig = await resolveTurnConfig(ctx);
  } catch (err: unknown) {
    const msg = `resolveTurnConfig hook error: ${errorMessage(err)}`;
    ctx.log.error(msg);
    span.setStatus({ code: 2, message: msg });
    span.end();
    finishToolCall(ctx, call_id, msg);
    return;
  }

  const refused = checkTurnLimits(ctx, turnConfig, name);
  if (refused !== null) {
    span.setAttribute("aai.tool.refused", true);
    span.end();
    finishToolCall(ctx, call_id, refused);
    return;
  }

  fireHook(ctx, "onStep", (h) =>
    h.onStep(
      ctx.id,
      {
        stepNumber: ctx.toolCallCount - 1,
        toolCalls: [{ toolName: name, args: parsedArgs }],
        text: "",
      },
      HOOK_TIMEOUT_MS,
    ),
  );

  ctx.log.info("S2S tool call", { tool: name, call_id, args: parsedArgs, agent: ctx.agent });
  toolCallCounter.add(1, { agent: ctx.agent, tool: name });

  let result: string;
  try {
    result = await ctx.executeTool(name, parsedArgs, ctx.id, ctx.conversationMessages);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    ctx.log.error("Tool execution failed", { tool: name, error: msg });
    toolCallErrorCounter.add(1, { agent: ctx.agent, tool: name });
    span.setStatus({ code: 2, message: msg });
    span.recordException(err instanceof Error ? err : new Error(msg));
    result = JSON.stringify({ error: msg });
  }

  toolCallDuration.record((performance.now() - startTime) / 1000, {
    agent: ctx.agent,
    tool: name,
  });
  ctx.log.info("S2S tool result", { tool: name, call_id, resultLength: result.length });
  finishToolCall(ctx, call_id, result);
  span.end();
}

/** Wire all S2S events to the client sink, hooks, and session state. */
function setupListeners(ctx: S2sSessionCtx, handle: S2sHandle): void {
  handle.on("ready", ({ session_id }) => {
    ctx.log.info("S2S session ready", { session_id });
  });

  handle.on("session_expired", () => {
    ctx.log.info("S2S session expired");
    handle.close();
  });

  handle.on("speech_started", () => ctx.client.event({ type: "speech_started" }));
  handle.on("speech_stopped", () => ctx.client.event({ type: "speech_stopped" }));

  handle.on("user_transcript_delta", ({ text }) => {
    ctx.client.event({ type: "transcript", text, isFinal: false });
  });

  handle.on("user_transcript", ({ text }) => {
    ctx.log.info("S2S user transcript", { text });
    turnCounter.add(1, { agent: ctx.agent });
    ctx.client.event({ type: "transcript", text, isFinal: true });
    ctx.client.event({ type: "turn", text });
    ctx.conversationMessages.push({ role: "user", content: text });
    fireHook(ctx, "onTurn", (h) => h.onTurn(ctx.id, text, HOOK_TIMEOUT_MS));
  });

  handle.on("reply_started", () => {
    ctx.toolCallCount = 0;
  });

  handle.on("audio", ({ audio }) => {
    ctx.client.playAudioChunk(audio);
  });

  handle.on("agent_transcript_delta", ({ text }) => {
    ctx.client.event({ type: "chat_delta", text });
  });

  handle.on("agent_transcript", ({ text }) => {
    ctx.client.event({ type: "chat", text });
    ctx.conversationMessages.push({ role: "assistant", content: text });
  });

  handle.on("tool_call", (detail) => {
    const p = handleToolCall(ctx, detail).catch((err: unknown) => {
      ctx.log.error("Tool call handler failed", { err: errorMessage(err) });
    });
    ctx.turnPromise = (ctx.turnPromise ?? Promise.resolve()).then(() => p);
  });

  handle.on("reply_done", ({ status }) => {
    if (status === "interrupted") {
      ctx.log.info("S2S reply interrupted (barge-in)");
      bargeInCounter.add(1, { agent: ctx.agent });
      ctx.pendingTools = [];
      ctx.client.event({ type: "cancelled" });
    } else if (ctx.pendingTools.length > 0) {
      for (const tool of ctx.pendingTools) ctx.s2s?.sendToolResult(tool.call_id, tool.result);
      ctx.pendingTools = [];
    } else {
      ctx.client.playAudioDone();
      ctx.client.event({ type: "tts_done" });
    }
  });

  handle.on("error", ({ code, message }) => {
    ctx.log.error("S2S error", { code, message });
    ctx.client.event({ type: "error", code: "internal", message });
    handle.close();
  });

  handle.on("close", () => {
    ctx.log.info("S2S closed");
    ctx.s2s = null;
  });
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

  const ctx: S2sSessionCtx = {
    id,
    agent,
    client,
    agentConfig,
    executeTool,
    hookInvoker,
    log,
    s2s: null,
    pendingTools: [],
    toolCallCount: 0,
    turnPromise: null,
    conversationMessages: [],
  };

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
      fireHook(ctx, "onConnect", (h) => h.onConnect(id, HOOK_TIMEOUT_MS));
      await connectAndSetup();
    },

    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      sessionAbort.abort();
      activeSessionsUpDown.add(-1, { agent });

      if (ctx.turnPromise !== null) await ctx.turnPromise;
      ctx.s2s?.close();
      fireHook(ctx, "onDisconnect", (h) => h.onDisconnect(id, HOOK_TIMEOUT_MS));
    },

    onAudio(data: Uint8Array): void {
      ctx.s2s?.sendAudio(data);
    },

    onAudioReady(): void {
      // S2S mode: greeting audio comes from S2S automatically. No-op.
    },

    onCancel(): void {
      // S2S handles barge-in natively.
      client.event({ type: "cancelled" });
    },

    onReset(): void {
      ctx.conversationMessages = [];
      ctx.toolCallCount = 0;
      ctx.turnPromise = null;
      ctx.pendingTools = [];
      ctx.s2s?.close();
      client.event({ type: "reset" });
      connectAndSetup().catch((err: unknown) => {
        log.error("S2S reset reconnect failed", { error: errorMessage(err) });
      });
    },

    onHistory(incoming: readonly { role: "user" | "assistant"; text: string }[]): void {
      ctx.conversationMessages.push(...fromWireMessages(incoming));
    },

    waitForTurn(): Promise<void> {
      return ctx.turnPromise ?? Promise.resolve();
    },
  };
}
