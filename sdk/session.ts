// Copyright 2025 the AAI authors. MIT license.
/**
 * S2S session — relays audio between the client and AssemblyAI's
 * Speech-to-Speech API, intercepting only tool calls for local execution.
 *
 * Cross-runtime: accepts Logger, Metrics, and a WebSocket factory instead of
 * importing Deno-specific modules.
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
    parameters: ts.parameters as Record<string, unknown>,
  }));
  let s2s: S2sHandle | null = null;
  const sessionAbort = new AbortController();
  let audioReady = false;
  let toolCallCount = 0;
  let turnPromise: Promise<void> | null = null;
  let conversationMessages: Message[] = [];
  let s2sSessionId: string | null = null;

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

  async function invokeHook(
    hook: "onConnect" | "onDisconnect" | "onTurn" | "onError" | "onStep",
    ...args: unknown[]
  ): Promise<void> {
    if (!hookInvoker) return;
    try {
      switch (hook) {
        case "onConnect":
          await hookInvoker.onConnect(id, HOOK_TIMEOUT_MS);
          break;
        case "onDisconnect":
          await hookInvoker.onDisconnect(id, HOOK_TIMEOUT_MS);
          break;
        case "onTurn":
          await hookInvoker.onTurn(id, args[0] as string, HOOK_TIMEOUT_MS);
          break;
        case "onError":
          await hookInvoker.onError(id, args[0] as { message: string }, HOOK_TIMEOUT_MS);
          break;
        case "onStep":
          await hookInvoker.onStep(id, args[0] as StepInfo, HOOK_TIMEOUT_MS);
          break;
      }
    } catch (err: unknown) {
      log.warn(`${hook} hook failed`, {
        err: err instanceof Error ? err.message : String(err),
      });
    }
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
    const maxSteps = turnConfig?.maxSteps ?? agentConfig.maxSteps;

    toolCallCount++;

    // Check maxSteps
    if (maxSteps !== undefined && toolCallCount > maxSteps) {
      log.info("maxSteps exceeded, refusing tool call", {
        toolCallCount,
        maxSteps,
      });
      pendingTools.push({
        call_id,
        result: "Maximum tool steps reached. Please respond to the user now.",
      });
      client.event({ type: "tool_call_done", toolCallId: call_id, result: "" });
      return;
    }

    // Check activeTools filter
    if (turnConfig?.activeTools && !turnConfig.activeTools.includes(name)) {
      log.info("Tool filtered by activeTools", { name });
      const errResult = JSON.stringify({
        error: `Tool "${name}" is not available at this step.`,
      });
      pendingTools.push({ call_id, result: errResult });
      client.event({
        type: "tool_call_done",
        toolCallId: call_id,
        result: errResult,
      });
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

  async function connectAndSetup(): Promise<void> {
    try {
      const handle = await _internals.connectS2s({
        apiKey,
        config: s2sConfig,
        createWebSocket,
        logger: log,
      });

      // Send session.update immediately on connect — before session.ready.
      if (s2sSessionId) {
        log.info("Attempting S2S session resume", {
          session_id: s2sSessionId,
        });
        handle.resumeSession(s2sSessionId);
      }
      // Send config without greeting first — greeting is deferred until
      // the client's audio is ready (onAudioReady) to avoid a race where
      // greeting audio arrives before the browser can play it.
      handle.updateSession({
        system_prompt: systemPrompt,
        tools: s2sTools,
      });

      handle.addEventListener("ready", ((e: CustomEvent<{ session_id: string }>) => {
        s2sSessionId = e.detail.session_id;
        log.info("S2S session ready", { session_id: s2sSessionId });
      }) as EventListener);

      handle.addEventListener("session_expired", (() => {
        log.info("S2S session expired, reconnecting fresh");
        s2sSessionId = null;
        handle.close();
      }) as EventListener);

      handle.addEventListener("speech_started", () => {
        client.event({ type: "speech_started" });
      });

      handle.addEventListener("speech_stopped", () => {
        client.event({ type: "speech_stopped" });
      });

      handle.addEventListener("user_transcript_delta", ((e: CustomEvent<{ text: string }>) => {
        client.event({
          type: "transcript",
          text: e.detail.text,
          isFinal: false,
        });
      }) as EventListener);

      handle.addEventListener("user_transcript", ((
        e: CustomEvent<{ item_id: string; text: string }>,
      ) => {
        const { text } = e.detail;
        log.info("S2S user transcript", { text });
        client.event({ type: "transcript", text, isFinal: true });
        client.event({ type: "turn", text });
        conversationMessages.push({ role: "user", content: text });
        invokeHook("onTurn", text);
      }) as EventListener);

      handle.addEventListener("reply_started", () => {
        toolCallCount = 0;
      });

      handle.addEventListener("audio", ((e: CustomEvent<{ audio: Uint8Array }>) => {
        client.playAudioChunk(e.detail.audio);
      }) as EventListener);

      handle.addEventListener("agent_transcript", ((e: CustomEvent<{ text: string }>) => {
        const { text } = e.detail;
        client.event({ type: "chat", text });
        conversationMessages.push({ role: "assistant", content: text });
      }) as EventListener);

      handle.addEventListener("tool_call", ((e: CustomEvent<S2sToolCall>) => {
        const p = handleToolCall(e.detail).catch((err: unknown) => {
          log.error("Tool call handler failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        });
        const prev = turnPromise;
        turnPromise = (prev ?? Promise.resolve())
          .then(() => p)
          .finally(() => {
            turnPromise = null;
          });
      }) as EventListener);

      handle.addEventListener("reply_done", ((e: CustomEvent<{ status?: string }>) => {
        if (e.detail.status === "interrupted") {
          log.info("S2S reply interrupted (barge-in)");
          // Discard pending tool results on interruption.
          pendingTools = [];
          client.event({ type: "cancelled" });
        } else {
          // Send all accumulated tool results after reply.done.
          if (pendingTools.length > 0) {
            for (const tool of pendingTools) {
              s2s?.sendToolResult(tool.call_id, tool.result);
            }
            pendingTools = [];
          } else {
            client.playAudioDone();
            client.event({ type: "tts_done" });
          }
        }
      }) as EventListener);

      handle.addEventListener("error", ((e: CustomEvent<{ code: string; message: string }>) => {
        log.error("S2S error", {
          code: e.detail.code,
          message: e.detail.message,
        });
        client.event({
          type: "error",
          code: "internal",
          message: e.detail.message,
        });
      }) as EventListener);

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

      s2s = handle;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("S2S connect failed", { error: msg });
      client.event({ type: "error", code: "internal", message: msg });
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
      // Now that the client can play audio, send greeting via session.update.
      if (agentConfig.greeting && s2s) {
        s2s.updateSession({
          system_prompt: systemPrompt,
          tools: s2sTools,
          greeting: agentConfig.greeting,
        });
      }
    },

    onCancel(): void {
      // S2S handles barge-in natively.
      client.event({ type: "cancelled" });
    },

    onReset(): void {
      conversationMessages = [];
      toolCallCount = 0;
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
