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
import { buildSystemPrompt } from "./system_prompt.ts";
import type { Message, StepInfo } from "./types.ts";
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
  let audioReady = false;
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
    } catch {
      return null;
    }
  }

  function invokeHook(hook: "onConnect"): void;
  function invokeHook(hook: "onDisconnect"): void;
  function invokeHook(hook: "onTurn", text: string): void;
  function invokeHook(hook: "onError", error: { message: string }): void;
  function invokeHook(hook: "onStep", step: StepInfo): void;
  function invokeHook(
    hook: "onConnect" | "onDisconnect" | "onTurn" | "onError" | "onStep",
    arg?: string | { message: string } | StepInfo,
  ): void {
    if (!hookInvoker) return;
    const run = async () => {
      switch (hook) {
        case "onConnect":
          await hookInvoker.onConnect(id, HOOK_TIMEOUT_MS);
          break;
        case "onDisconnect":
          await hookInvoker.onDisconnect(id, HOOK_TIMEOUT_MS);
          break;
        case "onTurn":
          await hookInvoker.onTurn(id, arg as string, HOOK_TIMEOUT_MS);
          break;
        case "onError":
          await hookInvoker.onError(id, arg as { message: string }, HOOK_TIMEOUT_MS);
          break;
        case "onStep":
          await hookInvoker.onStep(id, arg as StepInfo, HOOK_TIMEOUT_MS);
          break;
      }
    };
    run().catch((err: unknown) => {
      log.warn(`${hook} hook failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
    });
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
      const msg = err instanceof Error ? err.message : String(err);
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

      // Register all event listeners BEFORE sending any messages to avoid
      // a race where the server responds before listeners are attached.
      on<{ session_id: string }>(handle, "ready", (e) => {
        s2sSessionId = e.detail.session_id;
        log.info("S2S session ready", { session_id: s2sSessionId });
      });

      on<undefined>(handle, "session_expired", () => {
        log.info("S2S session expired, reconnecting fresh");
        s2sSessionId = null;
        handle.close();
      });

      handle.addEventListener("speech_started", () => {
        client.event({ type: "speech_started" });
      });

      handle.addEventListener("speech_stopped", () => {
        client.event({ type: "speech_stopped" });
      });

      on<{ text: string }>(handle, "user_transcript_delta", (e) => {
        client.event({
          type: "transcript",
          text: e.detail.text,
          isFinal: false,
        });
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
          log.error("Tool call handler failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        });
        turnPromise = (turnPromise ?? Promise.resolve()).then(() => p);
      });

      on<{ status?: string }>(handle, "reply_done", (e) => {
        if (e.detail.status === "interrupted") {
          log.info("S2S reply interrupted (barge-in)");
          // Discard pending tool results on interruption.
          pendingTools = [];
          client.event({ type: "cancelled" });
        } else if (pendingTools.length > 0) {
          // Send all accumulated tool results after reply.done.
          for (const tool of pendingTools) {
            s2s?.sendToolResult(tool.call_id, tool.result);
          }
          pendingTools = [];
        } else {
          client.playAudioDone();
          client.event({ type: "tts_done" });
        }
      });

      on<{ code: string; message: string }>(handle, "error", (e) => {
        log.error("S2S error", {
          code: e.detail.code,
          message: e.detail.message,
        });
        client.event({
          type: "error",
          code: "internal",
          message: e.detail.message,
        });
        // Close the S2S connection on error to prevent repeated error floods.
        handle.close();
      });

      handle.addEventListener("close", () => {
        log.info("S2S closed");
        s2s = null;
        if (!sessionAbort.signal.aborted) {
          log.info("Attempting S2S reconnect");
          connectAndSetup().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.error("S2S reconnect failed", { error: msg });
          });
        }
      });

      // Now that all listeners are registered, send the initial message.
      if (s2sSessionId) {
        // Reconnect: resume existing session — server already has config.
        log.info("Attempting S2S session resume", {
          session_id: s2sSessionId,
        });
        handle.resumeSession(s2sSessionId);
      } else {
        // Initial connect: send config with greeting.
        handle.updateSession({
          system_prompt: systemPrompt,
          tools: s2sTools,
          ...(agentConfig.greeting ? { greeting: agentConfig.greeting } : {}),
        });
      }

      s2s = handle;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("S2S connect failed", { error: msg });
      client.event({ type: "error", code: "internal", message: msg });
    } finally {
      connecting = false;
      if (pendingReconnect && !sessionAbort.signal.aborted) {
        pendingReconnect = false;
        connectAndSetup().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("S2S deferred reconnect failed", { error: msg });
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
      if (audioReady) return;
      audioReady = true;
      // Greeting audio + transcript come from S2S automatically.
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
