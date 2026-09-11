// Copyright 2025 the AAI authors. MIT license.
/**
 * Core type definitions for the AAI agent SDK.
 */

import type { AgentGuardrails } from "./agent-guardrails.ts";
import type { AgentSystemPrompt } from "./agent-instructions.ts";
import type { AgentModelTuning } from "./agent-model-tuning.ts";
import type { AgentObservation } from "./agent-observation.ts";
import type { PipelineVoiceTuning } from "./agent-voice-tuning.ts";
// Imported as well as re-exported below, for the reason `ToolDef` is: a
// re-export does not bring the name into this module's scope, and
// `AgentDef.builtinTools` needs it.
import type { BuiltinTool } from "./builtin-tools.ts";
import type { AnyDialog } from "./dialog-handle.ts";
import type { McpServers } from "./mcp-config.ts";
import type { LlmProvider, S2sProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { ToolInputSchema } from "./schema.ts";
import type { SubagentRoster } from "./subagent-roster.ts";
import type { TelephonyAccess } from "./telephony-config.ts";
// Imported as well as re-exported below: a re-export does not bring the name
// into this module's scope, and `AgentDef.tools` needs `ToolDef`.
import type { ToolChoice, ToolDef } from "./tool-def.ts";
// Imported as well as re-exported below, for the reason `PipelineVoiceTuning`
// is: `AgentDef` extends it.
import type { AgentVoicePresets } from "./voice-presets.ts";
import type { WorkflowDef } from "./workflow.ts";

/**
 * The guardrail vocabulary `AgentDef.inputGuardrails`/`outputGuardrails` are
 * written in — one of the three field groups split off this file at the cap
 * alongside {@link AgentModelTuning} and {@link AgentObservation}, and
 * re-exported here like every earlier split so no import moved. (No ordinal:
 * three landed together, so "the sixth" was a number about nothing.)
 * `agent-guardrails.ts` carries what a guardrail can and cannot prevent, which
 * is most of the design.
 */
export type {
  AgentGuardrail,
  AgentGuardrails,
  GuardrailVerdict,
} from "./agent-guardrails.ts";
/**
 * A system prompt computed per request — see `agent-instructions.ts` for where
 * the resolved text lands and how often it is asked for.
 */
export type { AgentInstructions, AgentSystemPrompt } from "./agent-instructions.ts";
/**
 * The knobs on the model loop this runtime runs, and the one rule they share
 * (S2S refuses all of them). Split off this file at the source-length cap, on
 * the seam {@link PipelineVoiceTuning} established.
 */
export type { AgentModelTuning, UsageLimits } from "./agent-model-tuning.ts";
/**
 * The two observe-only declarations (`syncState`, `events`), split off this
 * file at the cap. `agent-observation.ts` argues why they are one group and
 * why the boundary against `agent-guardrails.ts` is worth keeping visible.
 */
export type { AgentObservation } from "./agent-observation.ts";
/** What a per-session author FUNCTION is handed — see `agent-session-context.ts`. */
export type { AgentSessionContext } from "./agent-session-context.ts";
export type { PipelineVoiceTuning } from "./agent-voice-tuning.ts";
/**
 * The built-in tool vocabulary. A re-export because this module is the import
 * path everything already uses; the union itself moved when this file reached
 * the source-length cap.
 */
export type { BuiltinTool } from "./builtin-tools.ts";
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
// What the agent is LOOKING AT, split off as this file reached the 500-line cap
// — the fifth such split, and re-exported here like the other four so no import
// moved. See `sdk/message.ts` for the seam.
export type { Message } from "./message.ts";
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
 * The phone-carrier declaration `AgentDef.telephony` is written in. A type a
 * public signature mentions has to be reachable from the same page as the
 * signature, which is this one.
 */
export type { TelephonyAccess, TelephonyCarrier } from "./telephony-config.ts";
/**
 * What a tool's `execute` is handed. Kept as a re-export because this module is
 * the import path everything already uses, and because a tool author reads
 * `ToolContext` and `ToolDef` together.
 */
export type { ToolContext } from "./tool-context.ts";
/**
 * The tool-authoring types, re-exported from `./tool-def.ts` — this module is
 * the import path everything already uses, and a tool author reads
 * `ToolContext`, `ToolDef`, `DefaultToolResult` and the two inference helpers
 * together. `DefaultToolResult` moved there when this file hit the 500-line
 * cap: it is a tool-authoring type declared in a barrel, and the group it
 * belongs to was already one re-export line below it. The seven
 * `ToolMessages*`/`Tool*Message` names moved the same way when it hit the cap
 * AGAIN, `tool-def.ts` being the module that names them.
 */
export type {
  DefaultToolResult,
  InferToolInput,
  InferToolOutput,
  ToolChoice,
  ToolCompletionMessage,
  ToolConditionOperator,
  ToolDef,
  ToolDelayedMessage,
  ToolErrorHandler,
  ToolMessageCondition,
  ToolMessages,
  ToolMessagesInput,
  ToolStartMessage,
} from "./tool-def.ts";
/**
 * The opt-in prompt presets and the field that names them — the fifth field
 * group split off this file, re-exported here like the other four so no import
 * moved. `voice-presets.ts` carries the shipped text of each, what it costs on
 * every model request, and which default it overrides.
 */
export { type AgentVoicePresets, VOICE_PRESETS, type VoicePresetName } from "./voice-presets.ts";

/**
 * Fully resolved agent definition.
 *
 * **This is what `agent()` RETURNS, not what you write.** You write
 * {@link AgentParams} — the same fields with the defaulted ones optional, plus the
 * three conveniences `agent()` normalizes away (`llm` as a model-id string,
 * `voice`, `minTurnSilenceMs`/`maxTurnSilenceMs`). This is the reference for what
 * a field MEANS; `AgentParams` is the one for which combinations are legal.
 *
 * Core fields (`name`, `systemPrompt`, `greeting`, `maxSteps`, `tools`)
 * are resolved to their final values with defaults applied. Optional fields
 * (`sttPrompt`, the tuning knobs, the provider descriptors, etc.) remain
 * optional — `undefined` means "not configured."
 *
 * Five groups of fields live on interfaces this extends, each because the
 * group shares ONE rule that is derived from the declaration rather than
 * restated beside it: {@link PipelineVoiceTuning} (pipeline transport or
 * nothing), {@link AgentModelTuning} (this runtime assembles the request, so
 * S2S refuses them), {@link AgentGuardrails} (the only declarations that may
 * stop a turn), {@link AgentObservation} (the two that deliberately may
 * not) and {@link AgentVoicePresets} (paid for on every model request).
 * `agent()` and the deploy-time config check both derive their field
 * lists from those interfaces, so a new one cannot skip either gate.
 *
 * @public
 */
export interface AgentDef
  extends PipelineVoiceTuning,
    AgentModelTuning,
    AgentGuardrails,
    AgentObservation,
    AgentVoicePresets {
  /** Display name shown by the default client UI. */
  name: string;
  /**
   * What this agent IS, in one line, for whoever is reading a LIST of them.
   *
   * Its audience is never the model — a registry page, an A2A card, the
   * studio's agent picker, the CLI's `aai list`. Write it as the job the agent
   * does ("Books and reschedules dental appointments"), not as instructions;
   * the instructions are {@link AgentDef.systemPrompt}.
   *
   * Serializable, unlike most of what an author declares, and that is the whole
   * point: `tools`, `events` and `workflows` are host-only because a consumer
   * of a stored config could not act on a function, but a description is
   * exactly what such a consumer wants and could not get. Every peer SDK puts
   * one on the agent (Anthropic's `AgentDefinition.description` is required);
   * this SDK had one on {@link SubagentDef}, {@link WorkflowDef} and
   * {@link ToolDef} and none on the agent itself.
   */
  description?: string;
  /**
   * System prompt driving the LLM — the text, or a function that computes it
   * per request from {@link AgentSessionContext}.
   *
   * A resolver is how a prompt reads the session's own state: which phase the
   * dialog is in, whether the caller is authenticated, what is in the cart.
   * It is called once per model request (so once per STEP of a tool-calling
   * reply), synchronously, and its answer lands exactly where a string's does —
   * appended under the agent-specific-instructions header, after the
   * framework's voice sections. See `agent-instructions.ts`, which owns the
   * rest, including what an S2S agent gets (per-CONNECTION, not per-turn).
   *
   * ```ts
   * import { agent, sessionSlot } from "@alexkroman1/aai";
   *
   * const caller = sessionSlot("caller", () => ({ verified: false }));
   *
   * export default agent({
   *   name: "Bank Line",
   *   systemPrompt: (ctx) =>
   *     caller.get(ctx).verified
   *       ? "The caller is verified. You may discuss balances."
   *       : "The caller is NOT verified. Verify them before discussing anything.",
   * });
   * ```
   *
   * @defaultValue {@link DEFAULT_SYSTEM_PROMPT} — the framework's own voice-agent
   * prompt. It is assembled from parts, so it is the one default here whose
   * VALUE cannot usefully be inlined; read the constant.
   */
  systemPrompt: AgentSystemPrompt;
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
   * Subagents the MODEL may hand a task to, published as one `delegate` tool.
   *
   * The other half of `ctx.delegate`: a tool body naming a subagent is the
   * AUTHOR routing in code, a roster is the MODEL routing per turn. Every entry
   * needs a {@link SubagentDef.description} — the only thing the router reads —
   * and `agent()` refuses one without it. The one field whose declaration MINTS
   * A TOOL, so a `tools/delegate.ts` beside a roster is a collision; host-only,
   * like `tools`. Worked example and argument: `sdk/subagent-roster.ts`.
   */
  subagents?: SubagentRoster;
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
   * The dialogs this agent runs — see {@link dialog}. **Declaring one here is
   * what wires it to the SESSION**: its `@`-prefixed transitions fire (see
   * {@link DialogSessionEventName}), its states' `timeout` deadlines are armed,
   * and its {@link DialogVoiceConfig} is applied per state — none of which a
   * dialog can reach from inside a tool, because all three happen when no tool
   * is running. An UNDECLARED dialog is unchanged. Host-only, like `tools`.
   */
  dialogs?: readonly AnyDialog[];
  /**
   * What this agent's front door IS — and so whether it serves voice at all.
   * @defaultValue `"voice"`
   *
   * `"static"` declares a WORKFLOW APP: an ordinary web page over the workflow
   * HTTP API (`/workflows/*`), with no microphone, no WebSocket and no session.
   * The page is still a `client.tsx`, still React, still Tailwind — it just
   * mounts with `mountPage()` instead of `mountClient()` and reaches the agent
   * through
   * `createWorkflowApi()` / `useWorkflowRun()` instead of `useSession()`.
   *
   * Declaring it is not decoration. `createRuntimeServer` refuses the voice surfaces
   * for a static agent, so a page that has no session cannot be handed a socket
   * that would never answer, and {@link AgentDef.telephony} is a compile error
   * on one — an agent with no `stt`/`llm`/`tts` has nothing to put on a call.
   *
   * The two are not exclusive at the FEATURE level: a `"voice"` agent may
   * declare workflows and start them from a tool, and a `"static"` one may
   * declare tools it never reaches. This field is only about the surface.
   */
  page?: "voice" | "static";
  /**
   * Which phone carriers may open a media stream against this agent — and so
   * whether `WS /phone` is served at all.
   * @defaultValue none — the route is not mounted
   *
   * `true` admits every carrier the runtime ships a codec for; a list admits
   * exactly those (`telephony: ["twilio"]` refuses a Telnyx stream); `false`
   * and an absent field are the same refusal. See {@link TelephonyAccess}.
   *
   * Declaring it is what MOUNTS the route. It is the one surface an agent gets
   * that is dialled from OUTSIDE the deployment — a carrier reaches it by a URL
   * a phone number points at, not through the page this server hands a browser
   * — so an agent with no phone number has no use for it, and used to serve
   * both carriers' framing anyway from the moment it booted.
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * export default agent({ name: "Support", telephony: ["twilio"] });
   * ```
   */
  telephony?: TelephonyAccess;
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
