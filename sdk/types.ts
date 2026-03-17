// Copyright 2025 the AAI authors. MIT license.
/**
 * Core type definitions for the AAI agent SDK.
 *
 * @module
 */

import type { z } from "zod";
import type { Kv } from "./kv.ts";

/** Result of the {@linkcode AgentOptions.onBeforeStep} hook. */
export type BeforeStepResult = { activeTools?: string[] } | undefined;

/**
 * Transport protocol for client-server communication.
 *
 * - `"websocket"` — Browser-based WebSocket connection (default).
 */
export type Transport = "websocket";

/**
 * Voice pipeline mode.
 *
 * `"s2s"` — AssemblyAI Speech-to-Speech API. Single WebSocket handles
 * STT, LLM, and TTS with the lowest latency.
 */
export type PipelineMode = "s2s";

/** @internal Normalize a transport value to an array of transports. */
export function normalizeTransport(
  value: Transport | readonly Transport[] | undefined,
): readonly Transport[] {
  if (value === undefined) return ["websocket"];
  if (typeof value === "string") return [value];
  return value;
}

/**
 * Identifier for a built-in server-side tool.
 *
 * Built-in tools run on the host process (not inside the sandboxed worker)
 * and provide capabilities like web search, code execution, and API access.
 *
 * - `"web_search"` — Search the web for current information, facts, or news.
 * - `"visit_webpage"` — Fetch a URL and return its content as Markdown.
 * - `"fetch_json"` — Call a REST API endpoint and return the JSON response.
 * - `"run_code"` — Execute JavaScript in a sandbox for calculations and data processing.
 * - `"vector_search"` — Search the agent's RAG knowledge base for relevant documents.
 */
export type BuiltinTool =
  | "web_search"
  | "visit_webpage"
  | "fetch_json"
  | "run_code"
  | "vector_search";

/**
 * How the LLM should select tools during a turn.
 *
 * - `"auto"` — The model decides whether to call a tool.
 * - `"required"` — The model must call at least one tool.
 * - `"none"` — Tool calling is disabled.
 * - `{ type: "tool"; toolName: string }` — Force a specific tool.
 */
export type ToolChoice = "auto" | "required" | "none" | { type: "tool"; toolName: string };

/**
 * A single message in the conversation history.
 *
 * Messages are passed to tool `execute` functions via
 * {@linkcode ToolContext.messages} to provide conversation context.
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
 * @typeParam S The shape of per-session state created by the agent's
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
 */
export type ToolContext<S = Record<string, unknown>> = {
  /** Unique identifier for the current session. */
  sessionId: string;
  /** Environment variables declared in the agent config. */
  env: Readonly<Record<string, string>>;
  /** Signal that aborts when the tool execution times out. */
  abortSignal?: AbortSignal;
  /** Mutable per-session state created by the agent's `state` factory. */
  state: S;
  /** Key-value store scoped to this agent deployment. */
  kv: Kv;
  /** Read-only snapshot of conversation messages so far. */
  messages: readonly Message[];
};

/**
 * Context passed to lifecycle hooks (`onConnect`, `onTurn`, etc.).
 *
 * Similar to {@linkcode ToolContext} but without `messages` or `abortSignal`,
 * since hooks run outside the tool execution flow.
 *
 * @typeParam S The shape of per-session state created by the agent's
 *   `state` factory. Defaults to `Record<string, unknown>`.
 */
export type HookContext<S = Record<string, unknown>> = {
  /** Unique identifier for the current session. */
  sessionId: string;
  /** Environment variables declared in the agent config. */
  env: Readonly<Record<string, string>>;
  /** Mutable per-session state created by the agent's `state` factory. */
  state: S;
  /** Key-value store scoped to this agent deployment. */
  kv: Kv;
};

/**
 * Definition of a custom tool that the agent can invoke.
 *
 * Tools are the primary way to extend agent capabilities. Each tool has a
 * description (shown to the LLM), optional Zod parameters schema, and an
 * `execute` function that runs inside the sandboxed worker.
 *
 * @typeParam P A Zod object schema describing the tool's parameters.
 *   Defaults to `any` so tools without parameters don't need an explicit
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
 */
export type ToolDef<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  P extends z.ZodObject<z.ZodRawShape> = any,
  S = Record<string, unknown>,
> = {
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Zod schema for the tool's parameters. */
  parameters?: P | undefined;
  /** Function that executes the tool and returns a result. */
  execute(args: z.infer<P>, ctx: ToolContext<S>): Promise<unknown> | unknown;
};

/**
 * Available TTS voice identifiers (Cartesia voice UUIDs).
 *
 * Pass any Cartesia voice UUID as a string. The named constants below are
 * provided for convenience — the type also accepts arbitrary strings to
 * support custom or new voices without an SDK update.
 *
 * Browse all voices at https://play.cartesia.ai
 *
 * @default {"694f9389-aac1-45b6-b726-9d9369183238"} (Sarah)
 */
export type Voice =
  | "694f9389-aac1-45b6-b726-9d9369183238" // Sarah
  | "a167e0f3-df7e-4d52-a9c3-f949145efdab" // Customer Support Man
  | "829ccd10-f8b3-43cd-b8a0-4aeaa81f3b30" // Customer Support Lady
  | "156fb8d2-335b-4950-9cb3-a2d33befec77" // Helpful Woman
  | "248be419-c632-4f23-adf1-5324ed7dbf1d" // Professional Woman
  | "e3827ec5-697a-4b7c-9704-1a23041bbc51" // Sweet Lady
  | "79a125e8-cd45-4c13-8a67-188112f4dd22" // British Lady
  | "00a77add-48d5-4ef6-8157-71e5437b282d" // Calm Lady
  | "21b81c14-f85b-436d-aff5-43f2e788ecf8" // Laidback Woman
  | "996a8b96-4804-46f0-8e05-3fd4ef1a87cd" // Storyteller Lady
  | "bf991597-6c13-47e4-8411-91ec2de5c466" // Newslady
  | "cd17ff2d-5ea4-4695-be8f-42193949b946" // Meditation Lady
  | "15a9cd88-84b0-4a8b-95f2-5d583b54c72e" // Reading Lady
  | "c2ac25f9-ecc4-4f56-9095-651354df60c0" // Commercial Lady
  | "573e3144-a684-4e72-ac2b-9b2063a50b53" // Teacher Lady
  | "34bde396-9fde-4ebf-ad03-e3a1d1155205" // New York Woman
  | "b7d50908-b17c-442d-ad8d-810c63997ed9" // California Girl
  | "043cfc81-d69f-4bee-ae1e-7862cb358650" // Australian Woman
  | "a3520a8f-226a-428d-9fcd-b0a4711a6829" // Reflective Woman
  | "d46abd1d-2d02-43e8-819f-51fb652c1c61" // Newsman
  | "820a3788-2b37-4d21-847a-b65d8a68c99a" // Salesman
  | "69267136-1bdc-412f-ad78-0caad210fb40" // Friendly Reading Man
  | "f146dcec-e481-45be-8ad2-96e1e40e7f32" // Reading Man
  | "34575e71-908f-4ab6-ab54-b08c95d6597d" // New York Man
  | "ee7ea9f8-c0c1-498c-9279-764d6b56d189" // Polite Man
  | "b043dea0-a007-4bbe-a708-769dc0d0c569" // Wise Man
  | "63ff761f-c1e8-414b-b969-d1833d1c870c" // Confident British Man
  | "95856005-0332-41b0-935f-352e296aa0df" // Classy British Man
  | "bd9120b6-7761-47a6-a446-77ca49132781" // Tutorial Man
  | "7360f116-6306-4e9a-b487-1235f35a0f21" // Commercial Man
  | "5619d38c-cf51-4d8e-9575-48f61a280413" // Announcer Man
  | "2ee87190-8f84-4925-97da-e52547f9462c" // Child
  | (string & Record<never, never>);

/**
 * Information about a completed agentic step, passed to the `onStep` hook.
 *
 * Each turn may consist of multiple steps (up to `maxSteps`). A step
 * represents one LLM invocation that may include tool calls and text output.
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
 * Options passed to {@linkcode defineAgent} to configure an agent.
 *
 * Only `name` is required; all other fields have sensible defaults.
 *
 * @typeParam S The shape of per-session state returned by the `state`
 *   factory. Defaults to `any`.
 *
 * @example
 * ```ts
 * import { defineAgent } from "aai";
 * import { z } from "zod";
 *
 * export default defineAgent({
 *   name: "research-bot",
 *   instructions: "You help users research topics.",
 *   voice: "orion",
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
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentOptions<S = any> = {
  /** Display name for the agent. */
  name: string;
  /**
   * Environment variable names the agent requires at deploy time.
   *
   * @default {["ASSEMBLYAI_API_KEY"]}
   */
  env?: readonly string[];
  /**
   * Transport(s) the agent supports.
   *
   * @default {"websocket"}
   */
  transport?: Transport | readonly Transport[];
  /**
   * Voice pipeline mode.
   *
   * @default {"s2s"}
   */
  mode?: PipelineMode;
  /** System prompt for the LLM. Defaults to a built-in voice-optimized prompt. */
  instructions?: string;
  /** Initial spoken greeting when a session starts. */
  greeting?: string;
  /**
   * Cartesia voice UUID for TTS. Defaults to the server's configured voice
   * (Sarah) when omitted. Browse voices at https://play.cartesia.ai.
   */
  voice?: Voice;
  /** Prompt hint for the STT model to improve transcription accuracy. */
  sttPrompt?: string;
  /**
   * Maximum agentic loop iterations per turn. Can be a static number or
   * a function that receives the hook context and returns a number.
   *
   * @default {5}
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Readonly<Record<string, ToolDef<any, NoInfer<S>>>>;
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
 * Agent definition with all defaults applied, returned by
 * {@linkcode defineAgent}.
 *
 * Unlike {@linkcode AgentOptions}, every field here is resolved to its
 * final value — no optional fields with implicit defaults remain.
 */
export type AgentDef = {
  name: string;
  env: readonly string[];
  transport: readonly Transport[];
  mode?: PipelineMode | undefined;
  instructions: string;
  greeting: string;
  voice: string;
  sttPrompt?: string;
  maxSteps: number | ((ctx: HookContext) => number);
  toolChoice?: ToolChoice;
  builtinTools?: readonly BuiltinTool[];
  activeTools?: readonly string[];
  tools: Readonly<Record<string, ToolDef>>;
  state?: () => unknown;
  onConnect?: AgentOptions["onConnect"];
  onDisconnect?: AgentOptions["onDisconnect"];
  onError?: AgentOptions["onError"];
  onTurn?: AgentOptions["onTurn"];
  onStep?: AgentOptions["onStep"];
  onBeforeStep?: AgentOptions["onBeforeStep"];
};
