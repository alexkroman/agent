// Copyright 2025 the AAI authors. MIT license.
/**
 * S2S session — relays audio between the client and AssemblyAI's
 * Speech-to-Speech API, intercepting only tool calls for local execution.
 *
 * Cross-runtime: accepts Logger, Metrics, and a WebSocket factory via
 * dependency injection.
 *
 * @module
 */

import type { AgentConfig, ToolSchema } from "./_internal_types.ts";
import { errorMessage } from "./_utils.ts";
import type { ClientSink } from "./protocol.ts";
import { HOOK_TIMEOUT_MS } from "./protocol.ts";
import type { Logger, Metrics, S2SConfig } from "./runtime.ts";
import { consoleLogger, noopMetrics } from "./runtime.ts";
import {
  type CreateS2sWebSocket,
  connectS2s,
  type S2sHandle,
  type S2sToolCall,
  type S2sToolSchema,
} from "./s2s.ts";
import { DEFAULT_INSTRUCTIONS, type Message, type StepInfo } from "./types.ts";
import type { ExecuteTool } from "./worker_entry.ts";

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
  createWebSocket: CreateS2sWebSocket;
  env?: Record<string, string | undefined>;
  hookInvoker?: HookInvoker;
  skipGreeting?: boolean;
  logger?: Logger;
  metrics?: Metrics;
};

export const _internals = {
  connectS2s,
};

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
    createWebSocket,
    hookInvoker,
    logger: log = consoleLogger,
    metrics = noopMetrics,
  } = opts;

  const agentLabel = { agent };
  const agentConfig = opts.skipGreeting ? { ...opts.agentConfig, greeting: "" } : opts.agentConfig;

  // Build system prompt
  const hasTools = toolSchemas.length > 0 || (agentConfig.builtinTools?.length ?? 0) > 0;
  const systemPrompt = buildSystemPrompt(agentConfig, {
    hasTools,
    voice: true,
  });

  // toolSchemas already includes both agent-defined and builtin tools
  const s2sTools: S2sToolSchema[] = toolSchemas.map((ts) => ({
    type: "function" as const,
    name: ts.name,
    description: ts.description,
    parameters: ts.parameters,
  }));
  let s2s: S2sHandle | null = null;
  const sessionAbort = new AbortController();
  let toolCallCount = 0;
  let turnPromise: Promise<void> | null = null;
  let conversationMessages: Message[] = [];
  let s2sSessionId: string | null = null;
  /** Prevents overlapping connectAndSetup() calls (e.g. close handler firing during reconnect). */
  let connecting = false;
  let pendingReconnect = false;

  // Accumulate tool results — send after reply.done per API docs.
  type PendingTool = { call_id: string; result: string };
  let pendingTools: PendingTool[] = [];

  async function resolveTurnConfig(): Promise<{
    maxSteps?: number;
    activeTools?: string[];
  } | null> {
    if (!hookInvoker) return null;
    try {
      return await hookInvoker.resolveTurnConfig(id, HOOK_TIMEOUT_MS);
    } catch (err: unknown) {
      log.warn("resolveTurnConfig hook failed", { err: errorMessage(err) });
      return null;
    }
  }

  function invokeHook(hook: keyof HookInvoker, arg?: unknown): void {
    if (!hookInvoker) return;
    try {
      // biome-ignore lint/complexity/noBannedTypes: dynamic hook dispatch
      const h = hookInvoker[hook as keyof HookInvoker] as Function;
      Promise.resolve(h.call(hookInvoker, id, arg, HOOK_TIMEOUT_MS)).catch((err: unknown) => {
        log.warn(`${hook} hook failed`, { err: errorMessage(err) });
      });
    } catch (err: unknown) {
      log.warn(`${hook} hook failed`, { err: errorMessage(err) });
    }
  }

  /** Check if a tool call should be refused due to turn config limits. Returns a result string to short-circuit, or null. */
  function checkTurnLimits(
    turnConfig: { maxSteps?: number; activeTools?: string[] } | null,
    name: string,
  ): string | null {
    const maxSteps = turnConfig?.maxSteps ?? agentConfig.maxSteps;
    toolCallCount++;

    if (maxSteps !== undefined && toolCallCount > maxSteps) {
      log.info("maxSteps exceeded, refusing tool call", { toolCallCount, maxSteps });
      return "Maximum tool steps reached. Please respond to the user now.";
    }

    if (turnConfig?.activeTools && !turnConfig.activeTools.includes(name)) {
      log.info("Tool filtered by activeTools", { name });
      return JSON.stringify({ error: `Tool "${name}" is not available at this step.` });
    }

    return null;
  }

  async function handleToolCall(detail: S2sToolCall): Promise<void> {
    const { call_id, name, args: parsedArgs } = detail;

    // Emit tool_call_start to client
    client.event({
      type: "tool_call_start",
      toolCallId: call_id,
      toolName: name,
      args: parsedArgs,
    });

    // Resolve turn config for maxSteps / activeTools
    const turnConfig = await resolveTurnConfig();

    const refused = checkTurnLimits(turnConfig, name);
    if (refused !== null) {
      pendingTools.push({ call_id, result: refused });
      client.event({ type: "tool_call_done", toolCallId: call_id, result: refused });
      return;
    }

    // Fire onStep hook
    invokeHook("onStep", {
      stepNumber: toolCallCount - 1,
      toolCalls: [{ toolName: name, args: parsedArgs }],
      text: "",
    });

    log.info("S2S tool call", { tool: name, call_id, args: parsedArgs, agent });

    // Execute — all tools (custom + builtin) run via the executor
    let result: string;
    try {
      result = await executeTool(name, parsedArgs, id, conversationMessages);
    } catch (err: unknown) {
      const msg = errorMessage(err);
      log.error("Tool execution failed", { tool: name, error: msg });
      result = JSON.stringify({ error: msg });
    }

    log.info("S2S tool result", {
      tool: name,
      call_id,
      resultLength: result.length,
    });
    // Accumulate — don't send yet. Results are sent after reply.done.
    pendingTools.push({ call_id, result });
    client.event({ type: "tool_call_done", toolCallId: call_id, result });
  }

  /** Register a typed CustomEvent listener, consolidating the EventListener cast. */
  function on<T>(target: EventTarget, event: string, handler: (e: CustomEvent<T>) => void): void {
    target.addEventListener(event, handler as EventListener);
  }

  /** Wire all S2S events to the client sink, hooks, and session state. */
  function setupListeners(handle: S2sHandle): void {
    on<{ session_id: string }>(handle, "ready", (e) => {
      s2sSessionId = e.detail.session_id;
      log.info("S2S session ready", { session_id: s2sSessionId });
    });

    on<undefined>(handle, "session_expired", () => {
      log.info("S2S session expired, reconnecting fresh");
      s2sSessionId = null;
      handle.close();
    });

    // Simple event forwarding
    for (const type of ["speech_started", "speech_stopped"] as const) {
      handle.addEventListener(type, () => client.event({ type }));
    }

    on<{ text: string }>(handle, "user_transcript_delta", (e) => {
      client.event({ type: "transcript", text: e.detail.text, isFinal: false });
    });

    on<{ item_id: string; text: string }>(handle, "user_transcript", (e) => {
      const { text } = e.detail;
      log.info("S2S user transcript", { text });
      client.event({ type: "transcript", text, isFinal: true });
      client.event({ type: "turn", text });
      conversationMessages.push({ role: "user", content: text });
      invokeHook("onTurn", text);
    });

    handle.addEventListener("reply_started", () => {
      toolCallCount = 0;
    });

    on<{ audio: Uint8Array }>(handle, "audio", (e) => {
      client.playAudioChunk(e.detail.audio);
    });

    on<{ text: string }>(handle, "agent_transcript_delta", (e) => {
      client.event({ type: "chat_delta", text: e.detail.text });
    });

    on<{ text: string }>(handle, "agent_transcript", (e) => {
      const { text } = e.detail;
      client.event({ type: "chat", text });
      conversationMessages.push({ role: "assistant", content: text });
    });

    on<S2sToolCall>(handle, "tool_call", (e) => {
      const p = handleToolCall(e.detail).catch((err: unknown) => {
        log.error("Tool call handler failed", { err: errorMessage(err) });
      });
      turnPromise = (turnPromise ?? Promise.resolve()).then(() => p);
    });

    on<{ status?: string }>(handle, "reply_done", (e) => {
      if (e.detail.status === "interrupted") {
        log.info("S2S reply interrupted (barge-in)");
        pendingTools = [];
        client.event({ type: "cancelled" });
      } else if (pendingTools.length > 0) {
        for (const tool of pendingTools) s2s?.sendToolResult(tool.call_id, tool.result);
        pendingTools = [];
      } else {
        client.playAudioDone();
        client.event({ type: "tts_done" });
      }
    });

    on<{ code: string; message: string }>(handle, "error", (e) => {
      log.error("S2S error", { code: e.detail.code, message: e.detail.message });
      client.event({ type: "error", code: "internal", message: e.detail.message });
      handle.close();
    });

    handle.addEventListener("close", () => {
      log.info("S2S closed");
      s2s = null;
      if (!sessionAbort.signal.aborted) {
        log.info("Attempting S2S reconnect");
        connectAndSetup().catch((err: unknown) => {
          log.error("S2S reconnect failed", { error: errorMessage(err) });
        });
      }
    });
  }

  async function connectAndSetup(): Promise<void> {
    if (connecting) {
      pendingReconnect = true;
      return;
    }
    connecting = true;
    try {
      const handle = await _internals.connectS2s({
        apiKey,
        config: s2sConfig,
        createWebSocket,
        logger: log,
      });

      // Register all listeners BEFORE sending messages to avoid races.
      setupListeners(handle);

      if (s2sSessionId) {
        log.info("Attempting S2S session resume", { session_id: s2sSessionId });
        handle.resumeSession(s2sSessionId);
      } else {
        handle.updateSession({
          system_prompt: systemPrompt,
          tools: s2sTools,
          ...(agentConfig.greeting ? { greeting: agentConfig.greeting } : {}),
        });
      }

      s2s = handle;
    } catch (err: unknown) {
      const msg = errorMessage(err);
      log.error("S2S connect failed", { error: msg });
      client.event({ type: "error", code: "internal", message: msg });
    } finally {
      connecting = false;
      if (pendingReconnect && !sessionAbort.signal.aborted) {
        pendingReconnect = false;
        connectAndSetup().catch((err: unknown) => {
          log.error("S2S deferred reconnect failed", { error: errorMessage(err) });
        });
      }
    }
  }

  return {
    async start(): Promise<void> {
      metrics.sessionsTotal.inc(agentLabel);
      metrics.sessionsActive.inc(agentLabel);
      invokeHook("onConnect");
      await connectAndSetup();
    },

    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      sessionAbort.abort();
      metrics.sessionsActive.dec(agentLabel);
      if (turnPromise) await turnPromise;
      s2s?.close();
      invokeHook("onDisconnect");
    },

    onAudio(data: Uint8Array): void {
      s2s?.sendAudio(data);
    },

    onAudioReady(): void {
      // S2S mode: greeting audio comes from S2S automatically. No-op.
    },

    onCancel(): void {
      // S2S handles barge-in natively.
      client.event({ type: "cancelled" });
    },

    onReset(): void {
      conversationMessages = [];
      toolCallCount = 0;
      turnPromise = null;
      pendingTools = [];
      s2sSessionId = null;
      s2s?.close();
      // Reconnect happens via the close handler.
      client.event({ type: "reset" });
    },

    onHistory(incoming: readonly { role: "user" | "assistant"; text: string }[]): void {
      for (const msg of incoming) {
        conversationMessages.push({ role: msg.role, content: msg.text });
      }
    },

    waitForTurn(): Promise<void> {
      return turnPromise ?? Promise.resolve();
    },
  };
}

// ─── System prompt builder ──────────────────────────────────────────────────

const VOICE_RULES =
  "\n\nCRITICAL OUTPUT RULES — you MUST follow these for EVERY response:\n" +
  "Your response will be spoken aloud by a TTS system and displayed as plain text.\n" +
  "- NEVER use markdown: no **, no *, no _, no #, no `, no [](), no ---\n" +
  "- NEVER use bullet points (-, *, •) or numbered lists (1., 2.)\n" +
  "- NEVER use code blocks or inline code\n" +
  "- NEVER mention tools, search, APIs, or technical failures to the user. " +
  "If a tool returns no results, just answer naturally without explaining why.\n" +
  "- Write exactly as you would say it out loud to a friend\n" +
  '- Use short conversational sentences. To list things, say "First," "Next," "Finally,"\n' +
  "- Keep responses concise — 1 to 3 sentences max";

export function buildSystemPrompt(
  config: AgentConfig,
  opts: { hasTools: boolean; voice?: boolean },
): string {
  const { hasTools } = opts;
  const agentInstructions =
    config.instructions && config.instructions !== DEFAULT_INSTRUCTIONS
      ? `\n\nAgent-Specific Instructions:\n${config.instructions}`
      : "";

  const toolPreamble = hasTools
    ? "\n\nWhen you decide to use a tool, ALWAYS say a brief natural phrase BEFORE the tool call " +
      '(e.g. "Let me look that up" or "One moment while I check"). ' +
      "This fills silence while the tool executes. Keep preambles to one short sentence."
    : "";

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    DEFAULT_INSTRUCTIONS +
    `\n\nToday's date is ${today}.` +
    agentInstructions +
    toolPreamble +
    (opts.voice ? VOICE_RULES : "")
  );
}
