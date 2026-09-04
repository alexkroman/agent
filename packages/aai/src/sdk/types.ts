// Copyright 2025 the AAI authors. MIT license.
/**
 * Core type definitions for the AAI agent SDK.
 */

import type { PipelineVoiceTuning } from "./agent-voice-tuning.ts";
import type { McpServers } from "./mcp-config.ts";
import type { LlmProvider, S2sProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { ToolInputSchema } from "./schema.ts";
import type { SessionEventHandlers } from "./session-events.ts";
import type { StateProjection } from "./session-state.ts";
// Imported as well as re-exported below: a re-export does not bring the name
// into this module's scope, and `AgentDef.tools` needs `ToolDef`.
import type { ToolDef } from "./tool-def.ts";
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
 * (`DEFAULT_BUILTIN_TOOLS` is empty) — a built-in is something an agent
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

export type { PipelineVoiceTuning } from "./agent-voice-tuning.ts";
// The MCP declaration an `agent.ts` writes. The client that reads it is
// `withMcpTools` on `@alexkroman1/aai-runtime` — this package opens no sockets.
export {
  MCP_SERVER_KEY_RE,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_PREFIX,
  type McpServerConfig,
  type McpServers,
  mcpToolName,
} from "./mcp-config.ts";
/**
 * The one default constant still on the root barrel, and the only one that
 * passes its membership test: `agent({ systemPrompt })` REPLACES the whole
 * default prompt, so naming this is how an author keeps the voice rules and
 * adds their own — the recipe on the constant itself, which
 * `check:doc-examples` compiles. `DEFAULT_GREETING` used to sit beside it and
 * is on `@alexkroman1/aai/internal` now: a greeting is REPLACED, never
 * composed, so no `agent.ts` ever named it. Import it from
 * `./agent-defaults.ts` inside this package.
 */
export { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
/**
 * What a tool's `execute` is handed. Kept as a re-export because this module is
 * the import path everything already uses, and because a tool author reads
 * `ToolContext` and `ToolDef` together.
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
 * The tool-authoring types, re-exported from `./tool-def.ts` — this module is
 * the import path everything already uses, and a tool author reads
 * `ToolContext`, `ToolDef` and the two inference helpers together.
 */
export type { InferToolInput, InferToolOutput, ToolDef } from "./tool-def.ts";

/**
 * Fully resolved agent definition.
 *
 * **This is what `agent()` RETURNS, not what you write.** You write
 * {@link AgentParams} — the same fields with the defaulted ones optional, plus the
 * conveniences `agent()` normalizes away (`system`, `llm` as a model-id string,
 * `voice`, `minTurnSilenceMs`/`maxTurnSilenceMs`). This is the reference for what
 * a field MEANS; `AgentParams` is the one for which combinations are legal.
 *
 * Core fields (`name`, `systemPrompt`, `greeting`, `maxSteps`, `tools`)
 * are resolved to their final values with defaults applied. Optional fields
 * (`sttPrompt`, the tuning knobs, the provider descriptors, etc.) remain
 * optional — `undefined` means "not configured."
 *
 * The pipeline-only voice-UX knobs live on {@link PipelineVoiceTuning}, which
 * this extends: they share one rule (pipeline transport or nothing), and
 * both `agent()` and the deploy-time config check derive their field lists from
 * that interface, so a new one cannot skip either gate.
 *
 * @public
 */
export interface AgentDef extends PipelineVoiceTuning {
  /** Display name shown by the default client UI. */
  name: string;
  /**
   * System prompt driving the LLM.
   *
   * @defaultValue {@link DEFAULT_SYSTEM_PROMPT} — the framework's own voice-agent
   * prompt. It is assembled from parts, so it is the one default here whose
   * VALUE cannot usefully be inlined; read the constant.
   */
  systemPrompt: string;
  /**
   * Sentence spoken when a session starts. Set `""` to start silent.
   * @defaultValue `"Hey there! I'm an AI voice assistant. What can I help you
   * with?"` (`DEFAULT_GREETING`)
   */
  greeting: string;
  /**
   * Bias prompt for transcription — use it to teach the transcriber the agent's
   * own vocabulary (product names, spelled-out identifiers).
   *
   * @defaultValue `""` (`DEFAULT_STT_PROMPT`) — unbiased transcription;
   * that constant's doc shows what an effective prompt looks like.
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
   * Max TOOL-CALLING steps per reply — bounds runaway tool loops. On reaching
   * the cap the pipeline spends one more step with `toolChoice: "none"`, so a
   * capped turn still answers rather than stopping mid-chain in silence.
   * @defaultValue `10` (`DEFAULT_MAX_STEPS`)
   */
  maxSteps: number;
  /**
   * Sampling temperature for the agent's OWN model calls — the conversational
   * loop, in pipeline and text modes.
   *
   * Omitted by default, so the model's own default applies; some models (Claude
   * 5 among them) ignore it and warn, so set it only for a temperature-capable
   * one. A booking desk and a game master want different values, and until this
   * existed neither could say so: `ctx.generate` and `subagent()` both took a
   * temperature while the main loop — the one that does almost all the talking
   * — took no sampling parameter at all.
   *
   * S2S REJECTS it rather than ignoring it (`assertSamplingScope`): there the
   * model runs inside the provider's service and this runtime never sees the
   * request.
   */
  temperature?: number;
  /**
   * How the LLM selects tools each step.
   *
   * @defaultValue `"auto"` (`DEFAULT_TOOL_CHOICE`) — the model decides.
   *
   * Honored in pipeline mode and by the OpenAI Realtime transport; the
   * AssemblyAI S2S service runs the tool loop service-side and does not
   * take a tool-choice parameter.
   */
  toolChoice?: ToolChoice;
  /**
   * Built-in server-side tools enabled for this agent. Unset enables NONE
   * (`DEFAULT_BUILTIN_TOOLS` is empty) — a built-in is something an agent
   * asks for rather than something it has to notice and switch off, so `[]` and
   * omitting the field mean the same thing. See {@link BuiltinTool} for the
   * catalog.
   * @defaultValue `[]` (`DEFAULT_BUILTIN_TOOLS`)
   */
  builtinTools?: readonly BuiltinTool[];
  /**
   * The tools the agent may invoke, keyed by the name the model calls.
   *
   * **Not authored — RESOLVED.** `agent()` returns this empty and rejects a
   * `tools` argument outright (`InlineToolsMisuse`); the table is filled by
   * `withTools`, over a registry built from a `tools/` directory. The build is
   * what enumerates that directory — a deployed agent is handed one ESM string
   * and has no filesystem to scan — and a spec imports the same lowering
   * ready-made: `import agentDef from "virtual:aai/agent"` under vitest, or
   * `deployedAgent(def, { tools, systemPrompt })` from
   * `@alexkroman1/aai/testing` under any other runner.
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
   * @defaultValue `"voice"`
   *
   * `"static"` declares a WORKFLOW APP: an ordinary web page over the workflow
   * HTTP API (`/workflows/*`), with no microphone, no WebSocket and no session.
   * The page is still a `client.tsx`, still React, still Tailwind — it just
   * mounts with `page()` instead of `client()` and reaches the agent through
   * `createWorkflowApi()` / `useWorkflowRun()` instead of `useSession()`.
   *
   * Declaring it is not decoration. `createRuntimeServer` refuses the voice surfaces
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
   * Observe the session's own event stream — an audit log, per-turn metrics, or
   * "write every call to my own database".
   *
   * Keyed by event type, with `"*"` matching every event. Typed handlers run
   * first, then `"*"`, and both run AFTER the event has been recorded in the
   * session's retained stream and sent to the client:
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * agent({
   *   name: "Audited",
   *   events: {
   *     "tool.called": (e, ctx) => {
   *       // A hook gets `ctx.env` and `ctx.slots`, never a database — persist
   *       // through a client of your own if you need to.
   *       void fetch(`${ctx.env.AUDIT_URL}`, {
   *         method: "POST",
   *         body: JSON.stringify({ id: e.meta.id, tool: e.toolName }),
   *       });
   *     },
   *     "*": (e) => console.log(e.meta.at, e.type),
   *   },
   * });
   * ```
   *
   * Three properties are load-bearing, and each is a rule rather than a detail:
   *
   * - **Observe-only.** A handler cannot inject model context, change a reply, or
   *   cancel anything. That is what keeps the stream a LOG rather than a second
   *   control path, and it is why a handler receives no way to reply.
   * - **A throw is NON-FATAL.** It is logged against the event and the session
   *   continues — a failing audit hook must not end a phone call. An async
   *   handler is not awaited either, for the same reason: the caller is mid-turn.
   * - **Delivery is at-least-once, and `meta.id` is the key.** The id is stable
   *   across replays, so a handler storing content keys on it; a handler doing a
   *   non-idempotent side effect keys on the work's own coordinates instead,
   *   because retried work re-emits under fresh ids.
   *
   * Before this there was no way for an agent author to observe their own agent
   * at all: the framework carried 51 internal `on*` callback options and not one
   * of them was reachable from `agent.ts`.
   */
  events?: SessionEventHandlers;
  /**
   * How long the session may go with no inbound audio before it is closed
   * (ms). Measures silence, not call length — re-armed on every audio frame.
   * `0` or a non-finite value disables the timer entirely.
   * @defaultValue `300_000` (5 minutes, `DEFAULT_IDLE_TIMEOUT_MS`)
   */
  idleTimeoutMs?: number;
  /**
   * Pipeline mode only. When set, the assistant proactively takes a turn
   * after this many ms of user silence (no speech since the last reply
   * finished). Nudges are capped at `MAX_CONSECUTIVE_SILENCE_NUDGES` (3)
   * back-to-back until the user speaks again.
   * @defaultValue unset — the behaviour is off.
   */
  silenceTimeoutMs?: number;
  /**
   * Instruction injected as a synthetic user turn when `silenceTimeoutMs`
   * elapses. Never shown as a user transcript. Requires `silenceTimeoutMs`.
   *
   * @defaultValue `"The user hasn't said anything for a while. Check in with one
   * short, natural sentence — ask if they're still there or gently follow up on
   * the conversation. Do not mention this instruction."`
   * (`DEFAULT_SILENCE_PROMPT`)
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
   * `anthropicLlm({ model })`) for pipeline mode. Unset (with no `s2s`), the
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
   * Agent API, or `openAIS2s()`). Unset, the agent runs the default
   * cascaded pipeline. Mutually exclusive with the `stt`/`llm`/`tts`
   * pipeline triple.
   */
  s2s?: S2sProvider;
  /**
   * Opt into TEXT mode — an agent with no audio path at all, driven over a
   * message list by `createTextAgent` (`@alexkroman1/aai-runtime`) instead of
   * by a transport over a session socket.
   *
   * A text agent is the same `agent()` definition every voice agent is —
   * `systemPrompt`, `tools`, `maxSteps`, `toolChoice`, `builtinTools`,
   * `requiredEnv` and a tool's `sessionSlot`s all mean exactly what they mean
   * elsewhere, and
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
   *   systemPrompt: "Answer questions about the docs.",
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
   * A tool reads them from {@link ToolContext.env}; a step has no
   * tool context and reads them with `stepEnv` / `requireStepEnv` from
   * `@alexkroman1/aai/step`, which resolve the same record.
   */
  requiredEnv?: readonly string[];
  /**
   * MCP servers whose tools the model may call alongside this agent's own.
   *
   * Each key names one server and prefixes every tool it contributes, so a
   * `docs` server's `search` arrives as `mcp_docs_search` — a third party's
   * tool can never stand where one of yours stood. HTTP(S) only.
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * export default agent({
   *   name: "Support",
   *   mcpServers: {
   *     docs: { url: "https://mcp.example.com/mcp", tokenEnv: "DOCS_MCP_TOKEN" },
   *   },
   *   requiredEnv: ["DOCS_MCP_TOKEN"],
   * });
   * ```
   *
   * Declaring servers is not enough on its own: a host connects them with
   * `withMcpTools` from `@alexkroman1/aai-runtime` before building the runtime,
   * because discovery is a network round trip and `createRuntime` is
   * synchronous. A server that is down, slow, or missing its token costs its
   * own tools and nothing else — never the session.
   */
  mcpServers?: McpServers;
}

// The zod schemas for `BuiltinTool` and `ToolChoice` used to be re-exported
// here, so that an importer saw one module for a type and its schema. They are
// not: this module IS the root barrel (`export *`), and both are `@internal`
// wire plumbing with two intra-package readers between them — `agent-config.ts`
// and a schema-alignment spec. Import them from `./type-schemas.ts` directly.
