// Copyright 2025 the AAI authors. MIT license.
/**
 * Core type definitions for the AAI agent SDK.
 */

import type { PipelineVoiceTuning } from "./agent-voice-tuning.ts";
import type { LlmProvider, S2sProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { StateProjection } from "./session-state.ts";
// Imported as well as re-exported below: a re-export does not bring the name into
// this module's scope, and `ToolDef.execute` needs it.
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
  | "calculate";

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
 * What a tool's `execute` is handed — see `tool-context.ts`, which owns it. Kept
 * as a re-export because `types.ts` is the import path everything already uses,
 * and because a tool author reads `ToolContext` and `ToolDef` together.
 */
export type { ToolContext } from "./tool-context.ts";

/**
 * Default type of a tool result observed on the client (`useToolResult`) —
 * `any`, so untyped reads compile. Pass the shape —
 * `useToolResult<Quote>("get_quote", …)` — for real checking.
 *
 * @remarks
 * `any` because a tool result is the author's own return value
 * round-tripped through JSON — the client already knows its shape, and the
 * framework cannot. The strict default (`unknown`) made reading one field a
 * compile error in a client that runs correctly, which blocked publishing
 * once `aai build` type-checked.
 *
 * @public
 */
export type DefaultToolResult = any;

/**
 * Definition of a custom tool that the agent can invoke.
 *
 * Tools are the primary way to extend agent capabilities. Each tool has a
 * description (shown to the LLM), an optional input schema, and an
 * `execute` function that runs inside the sandboxed worker.
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
 *   inputSchema: z.object({
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
export type ToolDef<P extends ToolInputSchema = ToolInputSchema> = {
  /** Human-readable description shown to the LLM. */
  description: string;
  /**
   * Schema for the tool's input, shown to the LLM and used to validate each
   * call's arguments before `execute` runs. Named after the Vercel AI SDK's
   * `tool({ inputSchema })`.
   */
  inputSchema?: P;
  /**
   * Function that executes the tool and returns a result. The result is
   * JSON-serialized for the LLM and the client, and capped at
   * {@link MAX_TOOL_RESULT_CHARS} (4000) characters — longer results are
   * trimmed and end with a `[truncated]` marker.
   */
  execute(args: InferSchemaOutput<P>, ctx: ToolContext): Promise<unknown> | unknown;
};

/**
 * The validated input type a tool's `execute` receives — inferred from the
 * tool's `inputSchema`. The Vercel AI SDK's `InferToolInput` pattern, so a
 * client (or another tool) can share the exact argument shape without
 * re-declaring it.
 *
 * ```ts
 * import { type InferToolInput, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const add = tool({
 *   description: "Add an item",
 *   inputSchema: z.object({ item: z.string() }),
 *   execute: ({ item }) => item,
 * });
 * type AddInput = InferToolInput<typeof add>; // { item: string }
 * ```
 *
 * @public
 */
export type InferToolInput<T extends ToolDef<ToolInputSchema>> = Parameters<T["execute"]>[0];

/**
 * The result type a tool's `execute` returns (awaited). Pair with
 * `useToolResult<InferToolOutput<typeof myTool>>(...)` in a custom client so
 * the rendered shape has a single source of truth.
 *
 * @public
 */
export type InferToolOutput<T extends ToolDef<ToolInputSchema>> = Awaited<ReturnType<T["execute"]>>;

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
export interface AgentDef extends PipelineVoiceTuning {
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
   * The tools the agent may invoke, keyed by the name the model calls.
   *
   * **Not authored — RESOLVED.** `agent()` returns this empty and rejects a
   * `tools` argument outright (`InlineToolsMisuse`); the table is filled by
   * `withTools`, over a registry built from a `tools/` directory. The build is
   * what enumerates that directory — a deployed agent is handed one ESM string
   * and has no filesystem to scan — and a spec does the same lowering with
   * `withDiscoveredTools(def, import.meta.glob("./tools/*.ts", { eager: true }))`.
   * So a tool's name is its FILE name and nothing else records it.
   *
   * @remarks
   * This record carries no state type, and there is none to carry: a tool reads
   * and writes session state through {@link sessionSlot}, which types the value
   * in the module that declares the slot. The `NoInfer<S>` this used to hold
   * existed to keep a single un-annotated tool from dragging the agent's whole
   * state shape back to `unknown`, which is a problem a slot does not have.
   */
  tools: Readonly<Record<string, ToolDef<ToolInputSchema>>>;
  /**
   * Durable workflows this agent may start, keyed by workflow name.
   *
   * @remarks
   * The key is the NAME — nothing else records it, which is what makes a rename
   * a one-place change and what `ctx.workflows.start(def, …)` resolves a
   * definition against by identity.
   *
   * Host-only, like `tools`, because a definition holds a function. The platform
   * therefore never reads this record: a page's `GET /workflows` listing is
   * served by the GUEST from its own live agent definition, the same way
   * `name`/`greeting` are proxied rather than read from the stored config.
   */
  workflows?: Readonly<Record<string, WorkflowDef>>;
  /**
   * What this agent's front door IS — and so whether it serves voice at all.
   * Defaults to `"voice"`.
   *
   * `"static"` declares a WORKFLOW APP: an ordinary web page over the workflow
   * HTTP API (`/workflows/*`), with no microphone, no WebSocket and no session.
   * The page is still a `client.tsx`, still React, still Tailwind — it just
   * mounts with `page()` instead of `client()` and reaches the agent through
   * `createWorkflowApi()` / `useWorkflowRun()` instead of `useSession()`.
   *
   * Declaring it is not decoration. `createServer` refuses the voice surfaces
   * for a static agent, so a page that has no session cannot be handed a socket
   * that would never answer, and telephony defaults off for one — an agent with
   * no `stt`/`llm`/`tts` has nothing to put on a phone call.
   *
   * The two are not exclusive at the FEATURE level: a `"voice"` agent may
   * declare workflows and start them from a tool, and a `"static"` one may
   * declare tools it never reaches. This field is only about the surface.
   */
  page?: "voice" | "static";
  /**
   * Project per-session state to the browser client, so a custom UI can
   * render it without the agent hand-rolling a sync channel.
   *
   * One {@link SessionSlot.projection} per slot the client should see, or an
   * array of them — the `agent_state` frame carries the merge. A slot the agent
   * does not project never leaves the server, which is the point: session state
   * routinely holds things a browser should not have, so the author decides what
   * leaves, and whatever a projection returns is exactly what `useAgentState`
   * receives.
   *
   * Pushed after every tool call, and only when a projection actually changed —
   * most turns do not touch state, and this shares a socket with 384 kbps of
   * PCM.
   *
   * ```ts
   * import { agent, sessionSlot } from "@alexkroman1/aai";
   * type Item = { sku: string; qty: number };
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as Item[], staffPin: "" }));
   *
   * agent({
   *   name: "Cart",
   *   // staffPin stays server-side
   *   syncState: cartSlot.projection((s) => ({ items: s.items })),
   * });
   * ```
   *
   * @remarks
   * It took a `(state: S) => unknown` over the whole state bag until the bag was
   * removed. A projection now names its own slot, which is what lets the runtime
   * render a session that has run no tool yet — the projection carries the
   * slot's default — and so what let `AgentDef.state` be deleted rather than
   * remembered.
   *
   * Without any of this, the pattern agents reach for is: return a state
   * snapshot from every tool, declare a result type describing it, and mirror it
   * into `useState` via `useToolResult`. Measured across generated agents, 58%
   * built some version of that by hand.
   */
  syncState?: StateProjection | readonly StateProjection[];
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
   * Opt into TEXT mode — an agent with no audio path at all, driven over a
   * message list by `createTextAgent` (`@alexkroman1/aai/runtime`) instead of
   * by a transport over a session socket.
   *
   * A text agent is the same `agent()` definition every voice agent is —
   * `systemPrompt`, `tools`, `maxSteps`, `toolChoice`, `builtinTools`,
   * `state`, `requiredEnv` all mean exactly what they mean elsewhere, and
   * tools run through the same executor, so one tool works in both. What it
   * drops is everything downstream of speech: `stt`, `tts` and `s2s` are
   * rejected (there is no audio to transcribe or synthesize), as are the
   * voice-UX tuning knobs and the silence nudge. `llm` is the one stage it
   * has, and it defaults to the AssemblyAI LLM Gateway like every other.
   *
   * Explicit, never derived — the same rule `s2s` follows. A mode reachable
   * by omission is one a config lands in when it loses a field, and the
   * symptom there would be a deployed voice agent that answers nothing.
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * export default agent({
   *   name: "Docs Assistant",
   *   text: true,
   *   system: "Answer questions about the docs.",
   * });
   * ```
   *
   * Its tools are files under `tools/`, exactly as a voice agent's are.
   */
  text?: true;
  /**
   * Env var names this agent's code reads (beyond provider credentials, which
   * are derived from the `stt`/`llm`/`tts`/`s2s` descriptors automatically).
   * Deploys check that every listed name is present in the agent's stored env,
   * so a missing key surfaces at deploy time instead of as a runtime failure on
   * the first tool call.
   *
   * A tool reads them from {@link ToolContext.env}; a `"use step"` body has no
   * tool context and reads them with `stepEnv` / `requireStepEnv` from
   * `@alexkroman1/aai/utils`, which resolve the same record.
   */
  requiredEnv?: readonly string[];
}

// The zod schemas for `BuiltinTool` and `ToolChoice` used to be re-exported
// here, so that an importer saw one module for a type and its schema. They are
// not: this module IS the root barrel (`export *`), and both are `@internal`
// wire plumbing with two intra-package readers between them — `agent-config.ts`
// and a schema-alignment spec. Import them from `./type-schemas.ts` directly.
