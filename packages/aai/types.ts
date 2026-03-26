// Copyright 2025 the AAI authors. MIT license.
/**
 * Core type definitions for the AAI agent SDK.
 */

import { z } from "zod";
import type { Kv } from "./kv.ts";
import type { VectorStore } from "./vector.ts";

/**
 * Result of the {@link AgentOptions.onBeforeStep} hook.
 * @public
 */
export type BeforeStepResult = { activeTools?: string[] } | undefined;

/**
 * Result returned by a `beforeTurn` middleware to block a turn.
 * @public
 */
export type MiddlewareBlockResult = { block: true; reason: string };

/**
 * Result returned by a `beforeToolCall` middleware hook to short-circuit tool execution.
 *
 * Return `{ result: string }` to skip execution and use a cached/synthetic result.
 * Return `{ block: true; reason: string }` to deny the tool call.
 * Return `{ args: Record<string, unknown> }` to transform the arguments.
 * Return `undefined` to proceed normally.
 *
 * @public
 */
export type ToolCallInterceptResult =
  | { result: string }
  | { block: true; reason: string }
  | { args: Record<string, unknown> }
  | undefined;

/**
 * Composable middleware for the agent lifecycle.
 *
 * Middleware can intercept turns, tool calls, and output at well-defined
 * points. Multiple middleware compose in array order: the first middleware
 * in the array runs first for "before" hooks and last for "after" hooks.
 *
 * @typeParam S - The shape of per-session state. Defaults to `Record<string, unknown>`.
 *
 * @public
 */
export type Middleware<S = Record<string, unknown>> = {
  /** Human-readable name for logging and debugging. */
  name: string;

  /**
   * Runs before each user turn. Can block the turn by returning
   * `{ block: true, reason: "..." }`. Return `undefined` to proceed.
   */
  beforeTurn?: (
    text: string,
    ctx: HookContext<S>,
  ) => MiddlewareBlockResult | undefined | Promise<MiddlewareBlockResult | undefined>;

  /**
   * Runs after each user turn completes (after all steps finish).
   */
  afterTurn?: (text: string, ctx: HookContext<S>) => void | Promise<void>;

  /**
   * Runs before each tool call. Can approve, deny, transform args, or
   * return a cached result.
   */
  beforeToolCall?: (
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    ctx: HookContext<S>,
  ) => ToolCallInterceptResult | undefined | Promise<ToolCallInterceptResult | undefined>;

  /**
   * Runs after each tool call completes. Useful for caching results,
   * logging, or analytics.
   */
  afterToolCall?: (
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    result: string,
    ctx: HookContext<S>,
  ) => void | Promise<void>;

  /**
   * Filters agent text output before it is sent to TTS. Return the
   * (possibly modified) text. Runs on every agent transcript chunk.
   */
  beforeOutput?: (text: string, ctx: HookContext<S>) => string | Promise<string>;
};

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
 * - `"vector_search"` — Search the agent's RAG knowledge base for relevant documents.
 * - `"memory"` — Persistent KV memory: save_memory, recall_memory, list_memories, forget_memory.
 *
 * @public
 */
export type BuiltinTool =
  | "web_search"
  | "visit_webpage"
  | "fetch_json"
  | "run_code"
  | "vector_search"
  | "memory";

/**
 * How the LLM should select tools during a turn.
 *
 * - `"auto"` — The model decides whether to call a tool.
 * - `"required"` — The model must call at least one tool.
 * - `"none"` — Tool calling is disabled.
 * - `{ type: "tool"; toolName: string }` — Force a specific tool.
 *
 * @public
 */
export type ToolChoice = "auto" | "required" | "none" | { type: "tool"; toolName: string };

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
 * import { type ToolDef } from "aai";
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
  /** Vector store scoped to this agent deployment. */
  vector: VectorStore;
  /** Read-only snapshot of conversation messages so far. */
  messages: readonly Message[];
  /**
   * Push an intermediate update to the client UI before the tool finishes.
   *
   * Use this to send progressive data so the UI can render partial results
   * immediately (e.g. a loading card, preview, or streaming data) instead
   * of waiting for the full tool result.
   *
   * The data is serialized to JSON and delivered as a `tool_call_update`
   * event on the client. Use `useToolCallUpdate` in the UI to consume it.
   *
   * No-op in sandbox (platform) mode.
   */
  sendUpdate(data: unknown): void;
};

/**
 * Context passed to lifecycle hooks (`onConnect`, `onTurn`, etc.).
 *
 * Same as {@link ToolContext} but without `messages`, since hooks
 * run outside the tool execution flow.
 *
 * @typeParam S - The shape of per-session state created by the agent's
 *   `state` factory. Defaults to `Record<string, unknown>`.
 *
 * @public
 */
export type HookContext<S = Record<string, unknown>> = Omit<
  ToolContext<S>,
  "messages" | "sendUpdate"
>;

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
 * import { type ToolDef } from "aai";
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
 * Identity helper that preserves the Zod schema generic for type inference.
 *
 * When tools are defined inline in `defineAgent({ tools: { ... } })`, the
 * generic `P` gets widened to the base `ZodObject` type, so `args` in
 * `execute` loses its specific shape. Wrapping a tool definition in
 * `defineTool()` lets TypeScript infer `P` from `parameters` and type
 * `args` correctly.
 *
 * @example
 * ```ts
 * import { defineAgent, defineTool } from "aai";
 * import { z } from "zod";
 *
 * export default defineAgent({
 *   name: "my-agent",
 *   tools: {
 *     greet: defineTool({
 *       description: "Greet the user",
 *       parameters: z.object({ name: z.string() }),
 *       execute: ({ name }) => `Hello, ${name}!`, // name is string
 *     }),
 *   },
 * });
 * ```
 *
 * @public
 */
export function defineTool<P extends z.ZodObject<z.ZodRawShape>, S = Record<string, unknown>>(
  def: ToolDef<P, S>,
): ToolDef<P, S> {
  return def;
}

/** Alias for {@link defineTool}. Prefer `defineTool` for clarity. */
export { defineTool as tool };

/**
 * Create a typed `defineTool` helper with the session state type baked in.
 *
 * When tools need access to typed session state, you'd normally have to write
 * verbose generics on every `defineTool` call. `createToolFactory` eliminates
 * that boilerplate by returning a `defineTool` variant that already knows `S`.
 *
 * @example
 * ```ts
 * import { createToolFactory, defineAgent } from "aai";
 * import { z } from "zod";
 *
 * interface PortfolioState { holdings: Map<string, number> }
 *
 * const tool = createToolFactory<PortfolioState>();
 *
 * export default defineAgent<PortfolioState>({
 *   name: "portfolio",
 *   state: () => ({ holdings: new Map() }),
 *   tools: {
 *     buy: tool({
 *       description: "Buy shares",
 *       parameters: z.object({ symbol: z.string(), qty: z.number() }),
 *       execute: (args, ctx) => {
 *         // args.symbol is string, ctx.state is PortfolioState
 *         ctx.state.holdings.set(args.symbol, args.qty);
 *       },
 *     }),
 *   },
 * });
 * ```
 *
 * @public
 */
export function createToolFactory<S = Record<string, unknown>>(): <
  P extends z.ZodObject<z.ZodRawShape>,
>(
  def: ToolDef<P, S>,
) => ToolDef<P, S> {
  return (def) => def;
}

/**
 * Information about a completed agentic step, passed to the `onStep` hook.
 *
 * Each turn may consist of multiple steps (up to `maxSteps`). A step
 * represents one LLM invocation that may include tool calls and text output.
 *
 * @public
 */
export type StepInfo = {
  /** 1-based step index within the current turn. */
  stepNumber: number;
  /** Tool calls made during this step. */
  toolCalls: readonly {
    toolName: string;
    args: Readonly<Record<string, unknown>>;
  }[];
  /** LLM text output for this step. */
  text: string;
};

/**
 * Options passed to {@link defineAgent} to configure an agent.
 *
 * Only `name` is required; all other fields have sensible defaults.
 *
 * @typeParam S - The shape of per-session state returned by the `state`
 *   factory. Defaults to `Record<string, unknown>`.
 *
 * @example
 * ```ts
 * import { defineAgent } from "aai";
 * import { z } from "zod";
 *
 * export default defineAgent({
 *   name: "research-bot",
 *   instructions: "You help users research topics.",
 *   builtinTools: ["web_search"],
 *   tools: {
 *     summarize: {
 *       description: "Summarize text",
 *       parameters: z.object({ text: z.string() }),
 *       execute: ({ text }) => text.slice(0, 200) + "...",
 *     },
 *   },
 * });
 * ```
 *
 * @public
 */
export type AgentOptions<S = Record<string, unknown>> = {
  /** Display name for the agent. */
  name: string;
  /** System prompt for the LLM. Defaults to a built-in voice-optimized prompt. */
  instructions?: string;
  /** Initial spoken greeting when a session starts. */
  greeting?: string;
  /** Prompt hint for the STT model to improve transcription accuracy. */
  sttPrompt?: string;
  /**
   * Maximum agentic loop iterations per turn. Can be a static number or
   * a function that receives the hook context and returns a number.
   *
   * @defaultValue 5
   */
  maxSteps?: number | ((ctx: HookContext<S>) => number);
  /** How the LLM should choose tools. */
  toolChoice?: ToolChoice;
  /** Built-in tools to enable (e.g. `"web_search"`, `"run_code"`). */
  builtinTools?: readonly BuiltinTool[];
  /**
   * Default set of active tools per turn.
   *
   * When set, only these tools are available to the LLM each turn.
   * Can be overridden dynamically per-turn via `onBeforeStep`.
   */
  activeTools?: readonly string[];
  /** Custom tools the agent can invoke. */
  tools?: Readonly<Record<string, ToolDef<z.ZodObject<z.ZodRawShape>, NoInfer<S>>>>;
  /** Factory that creates fresh per-session state. Called once per connection. */
  state?: () => S;
  /** Called when a new session connects. */
  onConnect?: (ctx: HookContext<S>) => void | Promise<void>;
  /** Called when a session disconnects. */
  onDisconnect?: (ctx: HookContext<S>) => void | Promise<void>;
  /** Called when an unhandled error occurs. */
  onError?: (error: Error, ctx?: HookContext<S>) => void;
  /** Called after a complete turn (all steps finished). */
  onTurn?: (text: string, ctx: HookContext<S>) => void | Promise<void>;
  /** Called after each agentic step completes. */
  onStep?: (step: StepInfo, ctx: HookContext<S>) => void | Promise<void>;
  /**
   * Called before each step; can restrict which tools are active.
   *
   * Return `{ activeTools: [...] }` to limit available tools for the
   * upcoming step, or `void` to keep all tools active.
   */
  onBeforeStep?: (
    stepNumber: number,
    ctx: HookContext<S>,
  ) => BeforeStepResult | Promise<BeforeStepResult>;

  /**
   * Composable middleware that intercepts turns, tool calls, and output.
   *
   * Middleware runs in array order for "before" hooks (first to last)
   * and reverse order for "after" hooks (last to first).
   */
  middleware?: readonly Middleware<S>[];
};

/**
 * Default system prompt used when `instructions` is not provided.
 *
 * Optimized for voice-first interactions: short sentences, no visual
 * formatting, confident tone, and concise answers.
 */
export const DEFAULT_INSTRUCTIONS: string = `\
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
 * Agent definition returned by {@link defineAgent}.
 *
 * Core fields (`name`, `instructions`, `greeting`, `maxSteps`, `tools`)
 * are resolved to their final values with defaults applied. Optional
 * behavioral fields (hooks, middleware, `sttPrompt`, etc.) remain
 * optional — `undefined` means "not configured."
 *
 * @public
 */
export type AgentDef<S = Record<string, unknown>> = {
  name: string;
  instructions: string;
  greeting: string;
  sttPrompt?: string;
  maxSteps: number | ((ctx: HookContext<S>) => number);
  toolChoice?: ToolChoice;
  builtinTools?: readonly BuiltinTool[];
  activeTools?: readonly string[];
  tools: Readonly<Record<string, ToolDef<z.ZodObject<z.ZodRawShape>, S>>>;
  state?: () => S;
  onConnect?: (ctx: HookContext<S>) => void | Promise<void>;
  onDisconnect?: (ctx: HookContext<S>) => void | Promise<void>;
  onError?: (error: Error, ctx?: HookContext<S>) => void;
  onTurn?: (text: string, ctx: HookContext<S>) => void | Promise<void>;
  onStep?: (step: StepInfo, ctx: HookContext<S>) => void | Promise<void>;
  onBeforeStep?: (
    stepNumber: number,
    ctx: HookContext<S>,
  ) => BeforeStepResult | Promise<BeforeStepResult>;
  middleware?: readonly Middleware<S>[];
};

// ─── Zod schemas ────────────────────────────────────────────────────────────

/** @internal Zod schema for {@link BuiltinTool}. Exported for reuse in internal schemas. */
export const BuiltinToolSchema = z.enum([
  "web_search",
  "visit_webpage",
  "fetch_json",
  "run_code",
  "vector_search",
  "memory",
]);

/** @internal Zod schema for {@link ToolChoice}. Exported for reuse in internal schemas. */
export const ToolChoiceSchema = z.union([
  z.enum(["auto", "required", "none"]),
  z.object({ type: z.literal("tool"), toolName: z.string().min(1) }),
]);

const ToolDefSchema = z.object({
  description: z.string().min(1, "Tool description must be non-empty"),
  parameters: z
    .custom<z.ZodType>(
      (val) => val === undefined || val instanceof z.ZodType,
      "Expected a Zod schema",
    )
    .optional(),
  execute: z.function(),
});

// ─── Compile-time drift guards ──────────────────────────────────────────────
// These type aliases catch at compile time if a manually maintained type
// drifts out of sync with its Zod schema counterpart. If they produce `never`,
// the types have diverged and the build will fail at first usage.

/** @internal Fails to compile if BuiltinTool and BuiltinToolSchema diverge. */
type _AssertBuiltinTool =
  BuiltinTool extends z.infer<typeof BuiltinToolSchema>
    ? z.infer<typeof BuiltinToolSchema> extends BuiltinTool
      ? true
      : never
    : never;
const _btCheck: _AssertBuiltinTool = true;
void _btCheck;

/** @internal Fails to compile if ToolChoice and ToolChoiceSchema diverge. */
type _AssertToolChoice =
  ToolChoice extends z.infer<typeof ToolChoiceSchema>
    ? z.infer<typeof ToolChoiceSchema> extends ToolChoice
      ? true
      : never
    : never;
const _tcCheck: _AssertToolChoice = true;
void _tcCheck;

const AgentOptionsSchema = z.object({
  name: z.string().min(1, "Agent name must be non-empty"),
  instructions: z.string().optional(),
  greeting: z.string().optional(),
  sttPrompt: z.string().optional(),
  maxSteps: z.union([z.number().int().positive(), z.function()]).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  builtinTools: z.array(BuiltinToolSchema).optional(),
  activeTools: z.array(z.string().min(1)).optional(),
  tools: z.record(z.string(), ToolDefSchema).optional(),
  state: z.function().optional(),
  onConnect: z.function().optional(),
  onDisconnect: z.function().optional(),
  onError: z.function().optional(),
  onTurn: z.function().optional(),
  onStep: z.function().optional(),
  onBeforeStep: z.function().optional(),
  middleware: z
    .array(
      z.object({
        name: z.string().min(1, "Middleware name must be non-empty"),
        beforeTurn: z.function().optional(),
        afterTurn: z.function().optional(),
        beforeToolCall: z.function().optional(),
        afterToolCall: z.function().optional(),
        beforeOutput: z.function().optional(),
      }),
    )
    .optional(),
});

// ─── defineAgent ────────────────────────────────────────────────────────────

/**
 * Create an agent definition from the given options, applying sensible defaults.
 *
 * This is the main entry point for defining a voice agent. The returned
 * `AgentDef` is consumed by the AAI server at deploy time.
 *
 * @param options - Configuration for the agent including name, instructions,
 *   tools, hooks, and other settings.
 * @returns A fully resolved agent definition with all defaults applied.
 *
 * @public
 *
 * @example Basic agent with a custom tool
 * ```ts
 * import { defineAgent } from "aai";
 * import { z } from "zod";
 *
 * export default defineAgent({
 *   name: "greeter",
 *   instructions: "You greet people warmly.",
 *   tools: {
 *     greet: {
 *       description: "Greet a user by name",
 *       parameters: z.object({ name: z.string() }),
 *       execute: ({ name }) => `Hello, ${name}!`,
 *     },
 *   },
 * });
 * ```
 */
export function defineAgent<S = Record<string, unknown>>(options: AgentOptions<S>): AgentDef<S> {
  AgentOptionsSchema.parse(options);
  return {
    ...options,
    instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
    greeting: options.greeting ?? DEFAULT_GREETING,
    maxSteps: options.maxSteps ?? 5,
    tools: options.tools ?? {},
  } as AgentDef<S>;
}
