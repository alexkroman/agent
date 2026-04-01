// Copyright 2025 the AAI authors. MIT license.
/**
 * Core type definitions for the AAI agent SDK.
 */

import type { Kv } from "./kv.ts";

/**
 * Identifier for a built-in server-side tool.
 *
 * @public
 */
export type BuiltinTool = "web_search" | "visit_webpage" | "fetch_json" | "run_code";

/**
 * How the LLM should select tools during a turn.
 *
 * @public
 */
export type ToolChoice = "auto" | "required" | "none" | { type: "tool"; toolName: string };

/**
 * A single message in the conversation history.
 *
 * @public
 */
export type Message = {
  role: "user" | "assistant" | "tool";
  content: string;
};

/**
 * A JSON Schema object describing tool parameters.
 *
 * @public
 */
export type JSONSchemaObject = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

/**
 * Context passed to tool `execute` functions.
 *
 * @public
 */
export type ToolContext<S = Record<string, unknown>> = {
  env: Readonly<Record<string, string>>;
  state: S;
  kv: Kv;
  messages: readonly Message[];
  fetch: typeof globalThis.fetch;
  sessionId: string;
};

/**
 * Context passed to lifecycle hooks (internal).
 *
 * @internal
 */
export type HookContext<S = Record<string, unknown>> = {
  env: Readonly<Record<string, string>>;
  state: S;
  kv: Kv;
  fetch: typeof globalThis.fetch;
  sessionId: string;
};

/**
 * Definition of a custom tool that the agent can invoke.
 *
 * Tools have a description (shown to the LLM), optional JSON Schema
 * parameters, and an `execute` function.
 *
 * @public
 */
export type ToolDef<S = Record<string, unknown>> = {
  description: string;
  parameters?: JSONSchemaObject;
  execute(args: Record<string, unknown>, ctx: ToolContext<S>): Promise<unknown> | unknown;
};

/**
 * A mapping of tool names to their result types.
 *
 * @public
 */
export type ToolResultMap<T extends Record<string, unknown> = Record<string, unknown>> = T;

/**
 * Default system prompt used when `systemPrompt` is not provided.
 */
export const DEFAULT_SYSTEM_PROMPT: string = `\
You are AAI, a helpful AI assistant.

Voice-First Rules:
- Optimize for natural speech. Avoid jargon unless central to the answer. \
Use short, punchy sentences.
- Never mention "search results," "sources," or "the provided text." \
Speak as if the knowledge is your own.
- No visual formatting. Do not say "bullet point," "bold," or "bracketed one." \
If you need to list items, say "First," "Next," and "Finally."
- Start with the most important information. No introductory filler.
- Be concise. Keep answers to 1-3 sentences. For complex topics, provide a high-level summary.
- Be confident. Avoid hedging phrases like "It seems that" or "I believe."
- If you don't have enough information, say so directly rather than guessing.
- Never use exclamation points. Keep your tone calm and conversational.`;

/** Default greeting spoken when a session starts. */
export const DEFAULT_GREETING: string =
  "Hey there. I'm a voice assistant. What can I help you with?";

/**
 * Internal agent definition used by the runtime.
 *
 * Built by merging agent.toml config with tools.ts exports.
 * Hooks are internal — not part of the user-facing contract.
 *
 * @internal
 */
export type AgentDef<S = Record<string, unknown>> = {
  name: string;
  systemPrompt: string;
  greeting: string;
  sttPrompt?: string;
  maxSteps: number | ((ctx: HookContext<S>) => number);
  toolChoice?: ToolChoice;
  builtinTools?: readonly BuiltinTool[];
  tools: Readonly<Record<string, ToolDef<S>>>;
  state?: () => S;
  onConnect?: (ctx: HookContext<S>) => void | Promise<void>;
  onDisconnect?: (ctx: HookContext<S>) => void | Promise<void>;
  onError?: (error: Error, ctx?: HookContext<S>) => void;
  onTurn?: (text: string, ctx: HookContext<S>) => void | Promise<void>;
  idleTimeoutMs?: number;
};
