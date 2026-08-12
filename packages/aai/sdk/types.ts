// Copyright 2025 the AAI authors. MIT license.
/**
 * Core type definitions for the AAI agent SDK.
 */

import type { PipelineVoiceTuning } from "./agent-voice-tuning.ts";
import type { LlmProvider, S2sProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { DefaultSessionState } from "./session-state.ts";
import type { ToolContext } from "./tool-context.ts";
import type { WorkflowDef } from "./workflow.ts";

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
 * When `builtinTools` is not set, NONE are enabled
 * ({@link DEFAULT_BUILTIN_TOOLS} is empty) — a built-in is something an agent
 * asks for rather than something it has to notice and switch off. Name the
 * ones you want; `[]` and omitting the field mean the same thing.
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
  | "calculate"
  | "workflow_status";

/**
 * How the LLM should select tools during a turn. Mirrors the Vercel AI
 * SDK's `toolChoice`.
 *
 * - `"auto"` — The model decides whether to call a tool (default).
 * - `"required"` — The model must call at least one tool each step.
 * - `"none"` — The model may not call tools this session.
 * - `{ type: "tool", toolName }` — The model must call the named tool.
 *
 * @public
 */
export type ToolChoice = "auto" | "required" | "none" | { type: "tool"; toolName: string };

// These three are the LEAVES `tool-context.ts` also needs, so they live in
// `session-state.ts`: importing them from here while this file imports
// `ToolContext` from there is a type-level CYCLE, and a cycle across these
// declarations does not merely warn — it silently degrades `ToolDef`'s state
// parameter until two tools with incompatible state shapes are mutually
// assignable (caught by `define.test-d.ts`'s variance assertion). Re-exported so
// every existing import is unchanged.
export type { DefaultSessionState, DefaultToolResult, Message } from "./session-state.ts";

// `ToolContext` lives in `tool-context.ts` — it is the largest single type here
// and the one an author reads most, and this file was at the 500-line cap. It is
// re-exported so `@alexkroman1/aai` and every existing import are unchanged.
export type { ToolContext } from "./tool-context.ts";

/**
 * Definition of a custom tool that the agent can invoke.
 *
 * Tools are the primary way to extend agent capabilities. Each tool has a
 * description (shown to the LLM), an optional `input` schema, and a `run`
 * function that runs inside the sandboxed worker.
 *
 * Those two names are deliberately the ones {@link WorkflowDef} uses: a tool and
 * a workflow are the same declaration at two durations, so the only word that
 * should differ between them is `tool` versus `workflow`. `inputSchema` and
 * `execute` are the previous spellings and still work — see the fields below.
 *
 * @typeParam P - The tool's input schema: any
 *   [Standard Schema](https://standardschema.dev) that can convert to JSON
 *   Schema — a Zod object schema (the documented default) or e.g. an
 *   ArkType type. Defaults to a permissive record schema so tools without
 *   inputs don't need an explicit type argument.
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const weatherTool = tool({
 *   description: "Get current weather for a city",
 *   input: z.object({
 *     city: z.string().describe("City name"),
 *   }),
 *   run: async ({ city }) => {
 *     const res = await fetch(`https://wttr.in/${city}?format=j1`);
 *     return await res.json();
 *   },
 * });
 * ```
 *
 * @public
 */
export type ToolDef<P extends ToolInputSchema = ToolInputSchema, S = DefaultSessionState> = {
  /** Human-readable description shown to the LLM. */
  description: string;
  /**
   * Schema for the tool's input, shown to the LLM and used to validate each
   * call's arguments before `run` executes. The same field name
   * {@link WorkflowDef.input} carries.
   */
  input?: P;
  /**
   * Function that runs the tool and returns a result. The result is
   * JSON-serialized for the LLM and the client, and capped at
   * {@link MAX_TOOL_RESULT_CHARS} (4000) characters — longer results are
   * trimmed and end with a `[truncated]` marker.
   *
   * Exactly one of `run` and `execute` is required; `tool()` throws naming the
   * pair when neither or both are given.
   *
   * Both handlers are declared METHOD-style (`run?(args, ctx)`, not
   * `run?: (args, ctx) => …`) and must stay that way: a method signature is
   * bivariant in its parameters, and under the strict checking a property-style
   * function type gets, a tool written without a state type argument stops being
   * assignable into a stateful agent's `tools` record — which is the ordinary
   * case. `define.test-d.ts` pins it.
   */
  run?(args: InferSchemaOutput<P>, ctx: ToolContext<S>): Promise<unknown> | unknown;
  /**
   * @deprecated Renamed to `input`. Still accepted, and will be removed in the
   * next major.
   */
  inputSchema?: P;
  /**
   * @deprecated Renamed to `run`. Still accepted, and will be removed in the
   * next major.
   */
  execute?(args: InferSchemaOutput<P>, ctx: ToolContext<S>): Promise<unknown> | unknown;
};

/**
 * A tool's handler: validated args, the per-call context, any result.
 *
 * Derived from {@link ToolDef} rather than declared, so it cannot drift from the
 * field it describes — and so it inherits that field's method-style bivariance
 * (see `ToolDef.run`).
 *
 * @public
 */
export type ToolHandler<
  P extends ToolInputSchema = ToolInputSchema,
  S = DefaultSessionState,
> = NonNullable<ToolDef<P, S>["run"]>;

/**
 * What {@link tool} returns: a {@link ToolDef} whose `run` is not optional.
 *
 * `ToolDef.run` has to be optional, because `execute` is the other legal
 * spelling and a def may carry either — but `tool()` normalizes and REJECTS a
 * def with no handler, so its result always has one. Saying so in the type is
 * what lets an author's own test call `myTool.run(args, ctx)` directly instead of
 * asserting the field is there; without it every template test needed a non-null
 * assertion, which is the exact thing the escape-hatch ratchet counts.
 *
 * @public
 */
export type DefinedTool<
  P extends ToolInputSchema = ToolInputSchema,
  S = DefaultSessionState,
> = ToolDef<P, S> & Required<Pick<ToolDef<P, S>, "run">>;

/**
 * The validated input type a tool's `run` receives — inferred from the tool's
 * `input` schema. The Vercel AI SDK's `InferToolInput` pattern, so a client (or
 * another tool) can share the exact argument shape without re-declaring it.
 *
 * ```ts
 * import { type InferToolInput, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const add = tool({
 *   description: "Add an item",
 *   input: z.object({ item: z.string() }),
 *   run: ({ item }) => item,
 * });
 * type AddInput = InferToolInput<typeof add>; // { item: string }
 * ```
 *
 * @public
 */
export type InferToolInput<T extends ToolDef<ToolInputSchema, DefaultSessionState>> = Parameters<
  NonNullable<T["run"] | T["execute"]>
>[0];

/**
 * The result type a tool's `run` returns (awaited). Pair with
 * `useToolResult<InferToolOutput<typeof myTool>>(...)` in a custom client so
 * the rendered shape has a single source of truth.
 *
 * @public
 */
export type InferToolOutput<T extends ToolDef<ToolInputSchema, DefaultSessionState>> = Awaited<
  ReturnType<NonNullable<T["run"] | T["execute"]>>
>;

/**
 * The per-session state shape of an agent — inferred from the definition
 * `agent()` returned, so client code can type a `syncState` projection or a
 * shared module can type `ToolContext<InferAgentState<typeof agentDef>>`.
 *
 * @public
 */
export type InferAgentState<A> = A extends AgentDef<infer S> ? S : never;

export { DEFAULT_GREETING } from "./agent-defaults.ts";
export type { PipelineVoiceTuning } from "./agent-voice-tuning.ts";
export { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";

/**
 * Fully resolved agent definition.
 *
 * Core fields (`name`, `systemPrompt`, `greeting`, `maxSteps`, `tools`)
 * are resolved to their final values with defaults applied. Optional fields
 * (`sttPrompt`, the tuning knobs, the provider descriptors, etc.) remain
 * optional — `undefined` means "not configured."
 *
 * The pipeline-only voice-UX knobs live on {@link PipelineVoiceTuning}, which
 * this extends: they share one rule (pipeline transport or nothing), and
 * `define.ts`/`config-rules.ts` derive their field lists from that interface so
 * a new one cannot skip either gate.
 *
 * @public
 */
export interface AgentDef<S = DefaultSessionState> extends PipelineVoiceTuning {
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
   * Bias prompt for transcription — use it to teach the transcriber the agent's
   * own vocabulary (product names, spelled-out identifiers). Defaults to empty
   * (unbiased transcription); see {@link DEFAULT_STT_PROMPT} for what an
   * effective prompt looks like, and why a generic default is worse than none.
   *
   * Honoured in both session modes: the pipeline passes it to its STT stage,
   * S2S sends it as `input.transcription_prompt` (trimmed to that field's
   * 1750-char cap). It was pipeline-only until measurement showed what it costs
   * to drop — on tau2-bench retail a transcription prompt took the caller's
   * spelled first name from 1 of 6 attempts correct to 6 of 6, and the S2S path
   * was ignoring the field without a warning.
   */
  sttPrompt?: string;
  /**
   * Max TOOL-CALLING steps per reply — bounds runaway tool loops. Defaults to
   * {@link DEFAULT_MAX_STEPS} (10). On reaching the cap the pipeline spends one
   * more step with `toolChoice: "none"`, so a capped turn still answers rather
   * than stopping mid-chain in silence.
   */
  maxSteps: number;
  /**
   * How the LLM selects tools each step. Defaults to `"auto"`
   * ({@link DEFAULT_TOOL_CHOICE}): the model decides when to call a tool.
   * Honored in pipeline mode and by the OpenAI Realtime transport; the
   * AssemblyAI S2S service runs the tool loop service-side and does not
   * take a tool-choice parameter.
   */
  toolChoice?: ToolChoice;
  /**
   * Built-in server-side tools enabled for this agent. Unset enables NONE
   * ({@link DEFAULT_BUILTIN_TOOLS} is empty) — a built-in is something an agent
   * asks for rather than something it has to notice and switch off, so `[]` and
   * omitting the field mean the same thing. See {@link BuiltinTool} for the
   * catalog.
   *
   * @remarks
   * This doc used to claim a "cognitive set" default of `think`/`remember`/
   * `recall`/`calculate`, contradicting {@link BuiltinTool}'s doc in this same
   * file and the constant itself. The empty default is the real one and is what
   * `host/runtime-tools.ts` applies.
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
  tools: Readonly<Record<string, ToolDef<ToolInputSchema, NoInfer<S>>>>;
  /**
   * Durable workflows this agent can start, keyed by name — the name
   * `ctx.workflows.start()` takes, and the name the journal records.
   *
   * A workflow is not a tool: the LLM never selects one, and it holds no
   * session state (a run outlives every session, so there is none to hold).
   * Tool code starts them; see {@link workflow} for the authoring shape and
   * "Durable workflows" in `packages/aai/CLAUDE.md` for the run semantics.
   *
   * Declaring workflows requires storage to be enabled for the app — the
   * journal is what makes a run survive the sandbox that started it.
   */
  workflows?: Readonly<Record<string, WorkflowDef>>;
  /**
   * What this agent's page IS — and so whether it serves voice at all. Defaults
   * to `"voice"`.
   *
   * `"static"` means the page is an ordinary web page over the
   * {@link AgentDef.workflows} HTTP API: both voice surfaces (`/websocket`,
   * `/phone`) are REFUSED rather than left listening, since a static app
   * declares no STT/LLM/TTS and a session it accepted is one it could not serve.
   *
   * Orthogonal to declaring workflows — a `"voice"` agent may declare them too
   * (a tool starts a run and answers the turn). See "A page can be STATIC" in
   * `packages/aai/CLAUDE.md`.
   */
  page?: "voice" | "static";
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
   * import { agent } from "@alexkroman1/aai";
   * type Item = { sku: string; qty: number };
   *
   * agent({
   *   name: "Cart",
   *   state: () => ({ cart: [] as Item[], staffPin: "" }),
   *   syncState: (s) => ({ cart: s.cart }),   // staffPin stays server-side
   * });
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
   * Pluggable STT provider for pipeline mode. Unset (with no `s2s`), the
   * stage defaults to AssemblyAI STT — each pipeline stage is individually
   * optional, and unset stages are filled from the all-AssemblyAI pipeline
   * (`assemblyAIPipeline()`).
   */
  stt?: SttProvider;
  /**
   * Pluggable LLM provider descriptor from `@alexkroman1/aai/llm` (e.g.
   * `anthropic({ model })`) for pipeline mode. Unset (with no `s2s`), the
   * stage defaults to the AssemblyAI LLM Gateway. Note this is pure
   * serializable data, not a Vercel AI SDK `LanguageModel` instance — the
   * host resolves the descriptor into a `LanguageModel` at session start,
   * using credentials from the agent's env.
   */
  llm?: LlmProvider;
  /**
   * Pluggable TTS provider for pipeline mode. Unset (with no `s2s`), the
   * stage defaults to AssemblyAI TTS (`agent()`'s `voice` shorthand picks
   * its voice).
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
}

// ─── Zod schemas ────────────────────────────────────────────────────────────

// Defined in type-schemas.ts and re-exported here, so importers see one module
// for a type and its schema. See that file for why they are split.
export { BuiltinToolSchema, ToolChoiceSchema } from "./type-schemas.ts";
