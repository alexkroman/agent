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
 * ({@link DEFAULT_BUILTIN_TOOLS}: think, remember, recall, calculate) are
 * enabled. Set `builtinTools` explicitly — including `[]` — to override.
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
 * Default type of `ctx.state` when an agent does not declare one — `any`, so
 * untyped state access compiles. Opt into real checking by annotating the
 * context (`ctx: ToolContext<Cart>`), which also makes the agent verify the
 * tool against its own state shape.
 *
 * @remarks
 * `any` deliberately, not `Record<string, unknown>`: session state is a
 * genuinely dynamic bag created by the agent's `state` factory, and `tool()`
 * can only learn its real shape from an annotated context. The stricter
 * default made the ordinary spelling
 * (`execute: (a, ctx) => ctx.state.cart.push(a)`) a compile error even
 * though it runs correctly — and once `aai build`/`aai deploy` started
 * running the project's own `tsc`, that refused to publish working agents
 * without catching bugs.
 *
 * @public
 */
export type DefaultSessionState = any;

/**
 * Default type of a tool result observed on the client (`useToolResult`) —
 * `any`, so untyped reads compile. Pass the shape —
 * `useToolResult<Quote>("get_quote", …)` — for real checking.
 *
 * @remarks
 * The client half of {@link DefaultSessionState}'s problem, and `any` for
 * the same reason: a tool result is the author's own return value
 * round-tripped through JSON — the client already knows its shape, and the
 * framework cannot. The strict default (`unknown`) made reading one field a
 * compile error in a client that runs correctly, which blocked publishing
 * once `aai build` type-checked.
 *
 * @public
 */
export type DefaultToolResult = any;

/**
 * Context passed to tool `execute` functions.
 *
 * Provides access to the session environment, state, database, and
 * conversation history from within a tool's execute handler.
 *
 * @typeParam S - The shape of per-session state created by the agent's
 *   `state` factory. Defaults to {@link DefaultSessionState}; annotate the
 *   context (`ctx: ToolContext<MyState>`) to get real checking.
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const lookupNote = tool({
 *   description: "Look up a note from the database",
 *   parameters: z.object({ id: z.string() }),
 *   execute: async ({ id }, ctx) => {
 *     const rows = await ctx.db.query("select body from notes where id = $1", [id]);
 *     return { id, note: rows[0] ?? null };
 *   },
 * });
 * ```
 *
 * @public
 */
export type ToolContext<S = DefaultSessionState> = {
  /**
   * Environment variables available to this agent's tools (from `.env` under
   * `aai dev`, `aai secret` in production). Custom keys a tool depends on
   * should be declared in {@link AgentDef.requiredEnv} so a missing value
   * fails at deploy time.
   */
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
   * no LLM is configured or named.
   */
  generate(options: GenerateOptions): Promise<GenerateResult>;
  /** Read-only snapshot of conversation messages so far. */
  messages: readonly Message[];
  /** Unique identifier for the current session. Useful for correlating logs across concurrent sessions. */
  sessionId: string;
  /**
   * Push a custom event to the connected browser client. Fire-and-forget:
   * events whose name exceeds {@link MAX_CLIENT_EVENT_NAME_LENGTH} or whose
   * serialized payload exceeds {@link MAX_CLIENT_EVENT_PAYLOAD_BYTES} are
   * dropped (with a warning log), not thrown.
   */
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
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const weatherTool = tool({
 *   description: "Get current weather for a city",
 *   parameters: z.object({
 *     city: z.string().describe("City name"),
 *   }),
 *   execute: async ({ city }) => {
 *     const res = await fetch(`https://wttr.in/${city}?format=j1`);
 *     return await res.json();
 *   },
 * });
 * ```
 *
 * @public
 */
export type ToolDef<
  P extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  S = DefaultSessionState,
> = {
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Zod schema for the tool's parameters. */
  parameters?: P;
  /**
   * Function that executes the tool and returns a result. The result is
   * JSON-serialized for the LLM and the client, and capped at
   * {@link MAX_TOOL_RESULT_CHARS} (4000) characters — longer results are
   * trimmed and end with a `[truncated]` marker.
   */
  execute(args: z.infer<P>, ctx: ToolContext<S>): Promise<unknown> | unknown;
};

export { DEFAULT_GREETING, DEFAULT_SYSTEM_PROMPT } from "./agent-defaults.ts";

/**
 * Fully resolved agent definition.
 *
 * Core fields (`name`, `systemPrompt`, `greeting`, `maxSteps`, `tools`)
 * are resolved to their final values with defaults applied. Optional fields
 * (`sttPrompt`, the tuning knobs, the provider descriptors, etc.) remain
 * optional — `undefined` means "not configured."
 *
 * @public
 */
export type AgentDef<S = DefaultSessionState> = {
  /** Display name shown by the default client UI. */
  name: string;
  /**
   * System prompt driving the LLM. Defaults to
   * {@link DEFAULT_SYSTEM_PROMPT} when not set on `agent()`.
   */
  systemPrompt: string;
  /**
   * Sentence spoken when a session starts. Defaults to
   * {@link DEFAULT_GREETING}; set `""` to start silent.
   */
  greeting: string;
  /**
   * Pipeline mode only. Bias prompt for the streaming STT — use it to teach
   * the transcriber the agent's own vocabulary (product names, spelled-out
   * identifiers). Defaults to empty (unbiased transcription); see
   * {@link DEFAULT_STT_PROMPT} for what an effective prompt looks like.
   */
  sttPrompt?: string;
  /**
   * Max tool calls per reply — bounds runaway tool loops. Defaults to
   * {@link DEFAULT_MAX_STEPS} (10).
   */
  maxSteps: number;
  /**
   * How the LLM selects tools each step. Defaults to `"auto"`
   * ({@link DEFAULT_TOOL_CHOICE}): the model decides when to call a tool.
   */
  toolChoice?: ToolChoice;
  /**
   * Built-in server-side tools enabled for this agent. Unset defaults to the
   * cognitive set {@link DEFAULT_BUILTIN_TOOLS} (`think`, `remember`,
   * `recall`, `calculate`); set explicitly — including `[]` — to override.
   */
  builtinTools?: readonly BuiltinTool[];
  /**
   * Custom tools the agent may invoke, keyed by tool name.
   *
   * @remarks
   * `NoInfer` so `state` is the ONLY thing `S` is inferred from. Without it a
   * single tool written without the state type (the common case — `tool()`
   * only learns `S` from an annotated context) drags `S` back to
   * `Record<string, unknown>` for the whole agent, and `ctx.state.x` silently
   * becomes `unknown` again. Tools are still *checked* against `S`.
   */
  tools: Readonly<Record<string, ToolDef<z.ZodObject<z.ZodRawShape>, NoInfer<S>>>>;
  /**
   * Factory creating this session's mutable state — the value tools read and
   * write as `ctx.state`. Called once per session; unset leaves `ctx.state`
   * an empty object.
   */
  state?: () => S;
  /**
   * Project per-session state to the browser client, so a custom UI can
   * render it without the agent hand-rolling a sync channel.
   *
   * A PROJECTION rather than a flag, for three reasons. `ctx.state` routinely
   * holds things that should not reach a browser or cannot be serialized, so
   * the author decides what leaves. Returning plain data makes serializability
   * the author's call rather than a runtime surprise. And it doubles as the
   * client's contract: whatever this returns is exactly what `useAgentState`
   * receives.
   *
   * Called after every tool call, and pushed only when the projection
   * actually changed — most turns do not touch state, and this shares a
   * socket with 384 kbps of PCM.
   *
   * ```ts
   * agent({
   *   state: () => ({ cart: [] as Item[], staffPin: "" }),
   *   syncState: (s) => ({ cart: s.cart }),   // staffPin stays server-side
   * })
   * ```
   *
   * Without it, the pattern agents reach for is: return a state snapshot from
   * every tool, declare a result type describing it, and mirror it into
   * `useState` via `useToolResult`. Measured across generated agents, 58%
   * built some version of that by hand.
   */
  syncState?: (state: S) => unknown;
  /**
   * How long the session may go with no inbound audio before it is closed
   * (ms). Measures silence, not call length — re-armed on every audio frame.
   * Defaults to {@link DEFAULT_IDLE_TIMEOUT_MS} (300 000, 5 minutes); `0` or
   * a non-finite value disables the timer entirely.
   */
  idleTimeoutMs?: number;
  /**
   * Pipeline mode only. When set, the assistant proactively takes a turn
   * after this many ms of user silence (no speech since the last reply
   * finished). Unset disables the behavior. Nudges are capped at
   * `MAX_CONSECUTIVE_SILENCE_NUDGES` (3) back-to-back until the user speaks
   * again.
   */
  silenceTimeoutMs?: number;
  /**
   * Instruction injected as a synthetic user turn when `silenceTimeoutMs`
   * elapses. Never shown as a user transcript. Defaults to
   * {@link DEFAULT_SILENCE_PROMPT}. Requires `silenceTimeoutMs`.
   */
  silencePrompt?: string;
  /**
   * Pipeline mode only. Minimum words in an interim transcript before user
   * speech barges in on (aborts) the agent's in-flight reply. Defaults to
   * {@link DEFAULT_MIN_BARGE_IN_WORDS} (2) so one-word backchannels ("yeah",
   * "mm-hmm") don't cut the agent off; set 1 to interrupt on any word.
   */
  minBargeInWords?: number;
  /**
   * Pipeline mode only. Minimum sustained speech (ms since the utterance's
   * first interim transcript) before an interim-triggered barge-in aborts the
   * agent's reply — a duration gate alongside `minBargeInWords`, mirroring
   * LiveKit's `min_interruption_duration`. Committed turns (STT finals) are
   * never gated. Defaults to {@link DEFAULT_INTERRUPTION_MIN_DURATION_MS}
   * (500); set 0 to disable the gate.
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
   * interrupted reply. Defaults to
   * {@link DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS} (2000); 0 disables
   * recovery.
   */
  falseInterruptionTimeoutMs?: number;
  /**
   * Pluggable STT provider. Set together with `llm` and `tts` to select
   * the pipeline providers; all three unset (and no `s2s`) defaults to the
   * all-AssemblyAI pipeline (`assemblyAIPipeline()`).
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
   * Pluggable S2S provider descriptor — the explicit opt-in to
   * speech-to-speech mode (e.g. `assemblyAIS2s()` for AssemblyAI's Voice
   * Agent API, or `openaiRealtime()`). Unset, the agent runs the default
   * cascaded pipeline. Mutually exclusive with the `stt`/`llm`/`tts`
   * pipeline triple.
   */
  s2s?: S2sProvider;
  /**
   * Env var names this agent's tools read from {@link ToolContext.env}
   * (beyond provider credentials, which are derived from the
   * `stt`/`llm`/`tts`/`s2s` descriptors automatically). Deploys check that
   * every listed name is present in the agent's stored env, so a missing key
   * surfaces at deploy time instead of as a runtime failure on the first
   * tool call.
   */
  requiredEnv?: readonly string[];
};

// ─── Zod schemas ────────────────────────────────────────────────────────────

// Defined in type-schemas.ts and re-exported here, so importers see one module
// for a type and its schema. See that file for why they are split.
export { BuiltinToolSchema, ToolChoiceSchema } from "./type-schemas.ts";
