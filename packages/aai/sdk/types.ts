// Copyright 2025 the AAI authors. MIT license.
/**
 * Core type definitions for the AAI agent SDK.
 */

import type { z } from "zod";
import type { Db } from "./db.ts";
import type { GenerateOptions, GenerateResult } from "./generate.ts";
import type { LlmProvider, S2sProvider, SttProvider, TtsProvider } from "./providers.ts";

/**
 * Identifier for a built-in server-side tool.
 *
 * Built-in tools run on the host process (not inside the sandboxed worker)
 * and provide capabilities like web search, code execution, and API access.
 *
 * - `"web_search"` — Search the web for current information, facts, or news.
 * - `"visit_webpage"` — Fetch a URL and return its content as clean text.
 * - `"get_page_design"` — Fetch a URL's raw HTML and CSS (markup, style blocks,
 *   linked stylesheets) to study or mimic a site's visual design.
 * - `"fetch_json"` — Call a REST API endpoint and return the JSON response.
 * - `"run_code"` — Execute JavaScript in a sandbox for calculations and data processing.
 * - `"think"` — Private no-op scratchpad for policy checks and planning (never spoken).
 * - `"remember"` — Save a confirmed fact (ID, code, date) to private session notes.
 * - `"recall"` — Read back facts saved with `remember`.
 * - `"calculate"` — Safely evaluate an arithmetic expression (no code execution).
 *
 * When `builtinTools` is not set, the cognitive defaults
 * (`DEFAULT_BUILTIN_TOOLS`: think, remember, recall, calculate) are enabled.
 * Set `builtinTools` explicitly — including `[]` — to override.
 *
 * @public
 */
export type BuiltinTool =
  | "web_search"
  | "visit_webpage"
  | "get_page_design"
  | "fetch_json"
  | "run_code"
  | "think"
  | "remember"
  | "recall"
  | "calculate";

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
 * Provides access to the session environment, state, database, and
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
 *   description: "Look up a note from the database",
 *   parameters: z.object({ id: z.string() }),
 *   execute: async ({ id }, ctx) => {
 *     const rows = await ctx.db.query("select body from notes where id = $1", [id]);
 *     return { id, note: rows[0] ?? null };
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
  /**
   * SQL database scoped to this app. Available when storage is enabled
   * (`aai storage enable`, or the Storage toggle in the studio); accessing
   * it otherwise throws.
   */
  db: Db;
  /**
   * One-shot LLM generation, executed on the host (like `db`).
   * Defaults to the agent's pipeline `llm`; pass `llm` in the options to use
   * another provider (its API key must be in the agent's env). Throws when
   * no LLM is configured or named. Powers the `@alexkroman1/aai/patterns`
   * combinators (sequential, parallel, route, orchestrate,
   * evaluatorOptimizer).
   */
  generate(options: GenerateOptions): Promise<GenerateResult>;
  /** Read-only snapshot of conversation messages so far. */
  messages: readonly Message[];
  /** Unique identifier for the current session. Useful for correlating logs across concurrent sessions. */
  sessionId: string;
  /** Push a custom event to the connected browser client. Fire-and-forget. */
  send(event: string, data: unknown): void;
  /**
   * Cooperative cancellation signal. Aborts when the turn that issued this
   * tool call is cancelled (barge-in, reset, or session stop). Long-running
   * tools should pass it to `fetch` etc. so their work stops promptly;
   * absent in execution contexts that don't support cancellation.
   */
  signal?: AbortSignal;
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
 * import type { ToolResultMap } from "@alexkroman1/aai";
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

export { DEFAULT_GREETING, DEFAULT_SYSTEM_PROMPT } from "./agent-defaults.ts";

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
   * Pipeline mode only. When set, the assistant proactively takes a turn
   * after this many ms of user silence (no speech since the last reply
   * finished). Unset disables the behavior. Nudges are capped at
   * `MAX_CONSECUTIVE_SILENCE_NUDGES` back-to-back until the user speaks again.
   */
  silenceTimeoutMs?: number;
  /**
   * Instruction injected as a synthetic user turn when `silenceTimeoutMs`
   * elapses. Never shown as a user transcript. Defaults to
   * `DEFAULT_SILENCE_PROMPT`. Requires `silenceTimeoutMs`.
   */
  silencePrompt?: string;
  /**
   * Pipeline mode only. Minimum words in an interim transcript before user
   * speech barges in on (aborts) the agent's in-flight reply. Defaults to
   * `DEFAULT_MIN_BARGE_IN_WORDS` (2) so one-word backchannels ("yeah",
   * "mm-hmm") don't cut the agent off; set 1 to interrupt on any word.
   */
  minBargeInWords?: number;
  /**
   * Pipeline mode only. Minimum sustained speech (ms since the utterance's
   * first interim transcript) before an interim-triggered barge-in aborts the
   * agent's reply — a duration gate alongside `minBargeInWords`, mirroring
   * LiveKit's `min_interruption_duration`. Committed turns (STT finals) are
   * never gated. Default 0 (disabled).
   */
  interruptionMinDurationMs?: number;
  /**
   * Pipeline mode only. Phrase spoken when the model's first action in a
   * turn is a tool call with no preceding speech, so the caller never hears
   * dead air. Defaults to `"One moment."`; set `""` to disable.
   */
  holdPhrase?: string;
  /**
   * Pipeline mode only. Phrase spoken when the turn's LLM stream fails, so a
   * provider outage hands the conversation back instead of going silent — a
   * failed turn produces no text, so nothing would otherwise reach TTS.
   * Defaults to {@link DEFAULT_ERROR_PHRASE}; set `""` to disable.
   */
  errorPhrase?: string;
  /**
   * Pipeline mode only. Phrase spoken when a provider fails to open, so a
   * session that cannot start says so instead of holding an open line in
   * silence. Only reachable when TTS itself came up — which is the usual case,
   * since STT and TTS open independently. Defaults to
   * {@link DEFAULT_START_FAILURE_PHRASE}; set `""` to disable.
   */
  startFailurePhrase?: string;
  /**
   * Pipeline mode only. False-interruption recovery window (ms): when a
   * barge-in aborts the agent's reply but no user turn commits within this
   * window (STT noise, hallucinated partial), the agent resumes the
   * interrupted reply. Defaults to `DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS`
   * (2000); 0 disables recovery.
   */
  falseInterruptionTimeoutMs?: number;
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
  /**
   * Pluggable S2S provider descriptor. When set, overrides the implicit
   * AssemblyAI default. Mutually exclusive with the `stt`/`llm`/`tts`
   * pipeline triple.
   */
  s2s?: S2sProvider;
};

// ─── Zod schemas ────────────────────────────────────────────────────────────

// Defined in type-schemas.ts and re-exported here, so importers see one module
// for a type and its schema. See that file for why they are split.
export { BuiltinToolSchema, ToolChoiceSchema } from "./type-schemas.ts";
