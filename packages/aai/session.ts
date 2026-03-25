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
import { DEFAULT_INSTRUCTIONS, type Message, type StepInfo } from "./types.ts";
import type { ExecuteTool } from "./worker-entry.ts";

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

  // Accumulate tool results — send after reply.done per API docs.
  type PendingTool = { call_id: string; result: string };
  let pendingTools: PendingTool[] = [];

  async function resolveTurnConfig(): Promise<{
    maxSteps?: number;
    activeTools?: string[];
  } | null> {
    if (!hookInvoker) return null;
    return await hookInvoker.resolveTurnConfig(id, toolCallCount, HOOK_TIMEOUT_MS);
  }

  function fireHook(name: string, fn: (h: HookInvoker) => Promise<void>): void {
    if (!hookInvoker) return;
    try {
      fn(hookInvoker).catch((err: unknown) => {
        log.warn(`${name} hook failed`, { err: errorMessage(err) });
      });
    } catch (err: unknown) {
      log.warn(`${name} hook failed`, { err: errorMessage(err) });
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
    let turnConfig: { maxSteps?: number; activeTools?: string[] } | null;
    try {
      turnConfig = await resolveTurnConfig();
    } catch (err: unknown) {
      const msg = `resolveTurnConfig hook error: ${errorMessage(err)}`;
      log.error(msg);
      pendingTools.push({ call_id, result: msg });
      client.event({ type: "tool_call_done", toolCallId: call_id, result: msg });
      return;
    }

    const refused = checkTurnLimits(turnConfig, name);
    if (refused !== null) {
      pendingTools.push({ call_id, result: refused });
      client.event({ type: "tool_call_done", toolCallId: call_id, result: refused });
      return;
    }

    // Fire onStep hook
    fireHook("onStep", (h) =>
      h.onStep(
        id,
        {
          stepNumber: toolCallCount - 1,
          toolCalls: [{ toolName: name, args: parsedArgs }],
          text: "",
        },
        HOOK_TIMEOUT_MS,
      ),
    );

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
    const truncatedResult =
      result.length > MAX_TOOL_RESULT_CHARS ? result.slice(0, MAX_TOOL_RESULT_CHARS) : result;
    client.event({ type: "tool_call_done", toolCallId: call_id, result: truncatedResult });
  }

  /** Wire all S2S events to the client sink, hooks, and session state. */
  function setupListeners(handle: S2sHandle): void {
    handle.on("ready", ({ session_id }) => {
      log.info("S2S session ready", { session_id });
    });

    handle.on("session_expired", () => {
      log.info("S2S session expired");
      handle.close();
    });

    handle.on("speech_started", () => client.event({ type: "speech_started" }));
    handle.on("speech_stopped", () => client.event({ type: "speech_stopped" }));

    handle.on("user_transcript_delta", ({ text }) => {
      client.event({ type: "transcript", text, isFinal: false });
    });

    handle.on("user_transcript", ({ text }) => {
      log.info("S2S user transcript", { text });
      client.event({ type: "transcript", text, isFinal: true });
      client.event({ type: "turn", text });
      conversationMessages.push({ role: "user", content: text });
      fireHook("onTurn", (h) => h.onTurn(id, text, HOOK_TIMEOUT_MS));
    });

    handle.on("reply_started", () => {
      toolCallCount = 0;
    });

    handle.on("audio", ({ audio }) => {
      client.playAudioChunk(audio);
    });

    handle.on("agent_transcript_delta", ({ text }) => {
      client.event({ type: "chat_delta", text });
    });

    handle.on("agent_transcript", ({ text }) => {
      client.event({ type: "chat", text });
      conversationMessages.push({ role: "assistant", content: text });
    });

    handle.on("tool_call", (detail) => {
      const p = handleToolCall(detail).catch((err: unknown) => {
        log.error("Tool call handler failed", { err: errorMessage(err) });
      });
      turnPromise = (turnPromise ?? Promise.resolve()).then(() => p);
    });

    handle.on("reply_done", ({ status }) => {
      if (status === "interrupted") {
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

    handle.on("error", ({ code, message }) => {
      log.error("S2S error", { code, message });
      client.event({ type: "error", code: "internal", message });
      handle.close();
    });

    handle.on("close", () => {
      log.info("S2S closed");
      s2s = null;
    });
  }

  async function connectAndSetup(): Promise<void> {
    try {
      const handle = await _internals.connectS2s({
        apiKey,
        config: s2sConfig,
        createWebSocket,
        logger: log,
      });

      // Register all listeners BEFORE sending messages to avoid races.
      setupListeners(handle);

      handle.updateSession({
        system_prompt: systemPrompt,
        tools: s2sTools,
        ...(agentConfig.greeting ? { greeting: agentConfig.greeting } : {}),
      });

      s2s = handle;
    } catch (err: unknown) {
      const msg = errorMessage(err);
      log.error("S2S connect failed", { error: msg });
      client.event({ type: "error", code: "internal", message: msg });
    }
  }

  return {
    async start(): Promise<void> {
      fireHook("onConnect", (h) => h.onConnect(id, HOOK_TIMEOUT_MS));
      await connectAndSetup();
    },

    async stop(): Promise<void> {
      if (sessionAbort.signal.aborted) return;
      sessionAbort.abort();

      if (turnPromise) await turnPromise;
      s2s?.close();
      fireHook("onDisconnect", (h) => h.onDisconnect(id, HOOK_TIMEOUT_MS));
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
      s2s?.close();
      client.event({ type: "reset" });
      connectAndSetup().catch((err: unknown) => {
        log.error("S2S reset reconnect failed", { error: errorMessage(err) });
      });
    },

    onHistory(incoming: readonly { role: "user" | "assistant"; text: string }[]): void {
      conversationMessages.push(...fromWireMessages(incoming));
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
