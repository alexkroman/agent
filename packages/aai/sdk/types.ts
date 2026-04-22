// Copyright 2025 the AAI authors. MIT license.
/**
 * Core type definitions for the AAI agent SDK.
 */

import { z } from "zod";
import type { Kv } from "./kv.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "./providers.ts";

/**
 * Identifier for a built-in server-side tool.
 *
 * Built-in tools run on the host process (not inside the sandboxed worker)
 * and provide capabilities like web search, code execution, and API access.
 *
 * - `"web_search"` — Search the web for current information, facts, or news.
 * - `"visit_webpage"` — Fetch a URL and return its content as clean text.
 * - `"fetch_json"` — Call a REST API endpoint and return the JSON response.
 * - `"run_code"` — Execute JavaScript in a sandbox for calculations and data processing.
 *
 * @public
 */
export type BuiltinTool = "web_search" | "visit_webpage" | "fetch_json" | "run_code";

/**
 * How the LLM should select tools during a turn.
 *
 * - `"auto"` — The model decides whether to call a tool (default).
 * - `"required"` — The model must call at least one tool each step.
 *
 * @public
 */
export type ToolChoice = "auto" | "required";

/**
 * A single message in the conversation history.
 *
 * Messages are passed to tool `execute` functions via
 * {@link ToolContext.messages} to provide conversation context.
 *
 * @public
 */
export type Message = {
  /** The role of the message sender. */
  role: "user" | "assistant" | "tool";
  /** The text content of the message. */
  content: string;
};

/**
 * Context passed to tool `execute` functions.
 *
 * Provides access to the session environment, state, KV store, and
 * conversation history from within a tool's execute handler.
 *
 * @typeParam S - The shape of per-session state created by the agent's
 *   `state` factory. Defaults to `Record<string, unknown>`.
 *
 * @example
 * ```ts
 * import { type ToolDef } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const myTool: ToolDef = {
 *   description: "Look up a value from the KV store",
 *   parameters: z.object({ key: z.string() }),
 *   execute: async ({ key }, ctx) => {
 *     const value = await ctx.kv.get(key);
 *     return { key, value };
 *   },
 * };
 * ```
 *
 * @public
 */
export type ToolContext<S = Record<string, unknown>> = {
  /** Environment variables declared in the agent config. */
  env: Readonly<Record<string, string>>;
  /** Mutable per-session state created by the agent's `state` factory. */
  state: S;
  /** Key-value store scoped to this agent deployment. */
  kv: Kv;
  /** Read-only snapshot of conversation messages so far. */
  messages: readonly Message[];
  /** Unique identifier for the current session. Useful for correlating logs across concurrent sessions. */
  sessionId: string;
  /** Push a custom event to the connected browser client. Fire-and-forget. */
  send(event: string, data: unknown): void;
};

/**
 * Definition of a custom tool that the agent can invoke.
 *
 * Tools are the primary way to extend agent capabilities. Each tool has a
 * description (shown to the LLM), optional Zod parameters schema, and an
 * `execute` function that runs inside the sandboxed worker.
 *
 * @typeParam P - A Zod object schema describing the tool's parameters.
 *   Defaults to `ZodObject<ZodRawShape>` so tools without parameters don't need an explicit
 *   type argument.
 *
 * @example
 * ```ts
 * import { type ToolDef } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const weatherTool: ToolDef<typeof params> = {
 *   description: "Get current weather for a city",
 *   parameters: z.object({
 *     city: z.string().describe("City name"),
 *   }),
 *   execute: async ({ city }) => {
 *     const res = await fetch(`https://wttr.in/${city}?format=j1`);
 *     return await res.json();
 *   },
 * };
 *
 * const params = z.object({ city: z.string() });
 * ```
 *
 * @public
 */
export type ToolDef<
  P extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  S = Record<string, unknown>,
> = {
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Zod schema for the tool's parameters. */
  parameters?: P;
  /** Function that executes the tool and returns a result. */
  execute(args: z.infer<P>, ctx: ToolContext<S>): Promise<unknown> | unknown;
};

/**
 * A mapping of tool names to their result types.
 *
 * Define this in a shared file (e.g. `shared.ts`) that both `agent.ts` and
 * `client.tsx` can import, so tool result types stay in sync without
 * duplication.
 *
 * @example
 * ```ts
 * // shared.ts
 * import type { ToolResultMap } from "@alexkroman1/aai-cli/types";
 *
 * export interface Pizza {
 *   id: number;
 *   size: "small" | "medium" | "large";
 *   toppings: string[];
 * }
 *
 * export type MyToolResults = ToolResultMap<{
 *   add_pizza: { added: Pizza; orderTotal: string };
 *   place_order: { orderNumber: number; total: string };
 * }>;
 * ```
 *
 * Then use with {@link aai-ui#useToolResult | useToolResult}:
 *
 * ```tsx
 * // client.tsx
 * import type { MyToolResults } from "./shared.ts";
 *
 * useToolResult<MyToolResults["add_pizza"]>("add_pizza", (result) => {
 *   console.log(result.added); // fully typed
 * });
 * ```
 *
 * @public
 */
export type ToolResultMap<T extends Record<string, unknown> = Record<string, unknown>> = T;

/**
 * Default system prompt used when `systemPrompt` is not provided.
 *
 * Optimized for voice-first interactions: short sentences, no visual
 * formatting, confident tone, and concise answers.
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
 * Fully resolved agent definition.
 *
 * Core fields (`name`, `systemPrompt`, `greeting`, `maxSteps`, `tools`)
 * are resolved to their final values with defaults applied. Optional
 * behavioral fields (hooks, `sttPrompt`, etc.) remain optional —
 * `undefined` means "not configured."
 *
 * @public
 */
export type AgentDef<S = Record<string, unknown>> = {
  name: string;
  systemPrompt: string;
  greeting: string;
  sttPrompt?: string;
  maxSteps: number;
  toolChoice?: ToolChoice;
  builtinTools?: readonly BuiltinTool[];
  tools: Readonly<Record<string, ToolDef<z.ZodObject<z.ZodRawShape>, S>>>;
  state?: () => S;
  idleTimeoutMs?: number;
  /**
   * Pluggable STT provider. Set together with `llm` and `tts` to enable
   * pipeline mode; all three unset means S2S mode.
   */
  stt?: SttProvider;
  /**
   * Pluggable LLM provider (Vercel AI SDK `LanguageModel`). Set together
   * with `stt` and `tts` for pipeline mode.
   */
  llm?: LlmProvider;
  /**
   * Pluggable TTS provider. Set together with `stt` and `llm` for
   * pipeline mode.
   */
  tts?: TtsProvider;
};

// ─── Zod schemas ────────────────────────────────────────────────────────────

/** @internal Zod schema for {@link BuiltinTool}. Exported for reuse in internal schemas. */
export const BuiltinToolSchema = z.enum(["web_search", "visit_webpage", "fetch_json", "run_code"]);

/** @internal Zod schema for {@link ToolChoice}. Exported for reuse in internal schemas. */
export const ToolChoiceSchema = z.enum(["auto", "required"]);
