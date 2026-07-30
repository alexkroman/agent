// Copyright 2025 the AAI authors. MIT license.

import type { z } from "zod";
import { DEFAULT_MAX_STEPS } from "./constants.ts";
import { none } from "./providers/tts/none.ts";
import type {
  LlmProvider,
  S2sProvider,
  SendProvider,
  SttProvider,
  TtsProvider,
  VectorProvider,
} from "./providers.ts";
import {
  type AgentDef,
  type BuiltinTool,
  DEFAULT_GREETING,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_WORKFLOW_GREETING,
  DEFAULT_WORKFLOW_SYSTEM_PROMPT,
  type ToolChoice,
  type ToolContext,
  type ToolDef,
} from "./types.ts";

/**
 * Define a tool with typed parameters and execute function.
 *
 * Identity function for type inference — returns the input unchanged.
 * Follows the Vercel AI SDK `tool()` pattern.
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const greet = tool({
 *   description: "Greet someone by name",
 *   parameters: z.object({ name: z.string() }),
 *   execute: ({ name }) => `Hello, ${name}!`,
 * });
 * ```
 *
 * @public
 */
export function tool<P extends z.ZodObject<z.ZodRawShape>>(def: {
  description: string;
  parameters?: P;
  execute(args: z.infer<P>, ctx: ToolContext): Promise<unknown> | unknown;
}): ToolDef<P> {
  return def;
}

/**
 * Define an agent with tools, system prompt, and configuration.
 *
 * Applies sensible defaults for omitted fields. Export as the default
 * export of your `agent.ts` file.
 *
 * @example
 * ```ts
 * import { agent, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const myTool = tool({
 *   description: "Echo a message",
 *   parameters: z.object({ message: z.string() }),
 *   execute: ({ message }) => message,
 * });
 *
 * export default agent({
 *   name: "Echo Agent",
 *   tools: { echo: myTool },
 * });
 * ```
 *
 * @remarks
 * Pipeline mode: pass `stt`, `llm`, and `tts` together to switch from the
 * default AssemblyAI Streaming Speech-to-Speech path to a pluggable
 * STT → LLM → TTS pipeline. All three must be set (or all left unset).
 *
 * @public
 */
export function agent(def: {
  name: string;
  systemPrompt?: string;
  greeting?: string;
  tools?: Record<string, ToolDef>;
  builtinTools?: BuiltinTool[];
  maxSteps?: number;
  toolChoice?: ToolChoice;
  sttPrompt?: string;
  idleTimeoutMs?: number;
  /**
   * Pipeline mode only. When set, the assistant proactively takes a turn
   * after this many ms of user silence. Unset disables the behavior.
   */
  silenceTimeoutMs?: number;
  /**
   * Instruction injected as a synthetic user turn when `silenceTimeoutMs`
   * elapses. Defaults to `DEFAULT_SILENCE_PROMPT`. Requires `silenceTimeoutMs`.
   */
  silencePrompt?: string;
  /**
   * Pipeline mode only. Minimum interim-transcript words before user speech
   * barges in on the agent's reply. Defaults to 2 so one-word backchannels
   * don't cut the agent off; set 1 to interrupt on any word.
   */
  minBargeInWords?: number;
  /**
   * Pipeline mode only. Minimum sustained speech (ms) before an
   * interim-triggered barge-in interrupts the reply, alongside
   * `minBargeInWords`. Defaults to 0 (disabled).
   */
  interruptionMinDurationMs?: number;
  /**
   * Pipeline mode only. Endpoint settle window (ms) after an STT final
   * before committing the user's turn. Defaults to 1500; 0 commits every
   * final immediately.
   */
  endpointSettleMs?: number;
  /**
   * Pipeline mode only. Settle window (ms) for clearly-complete finals,
   * capped by `endpointSettleMs`. Defaults to 500.
   */
  completeSettleMs?: number;
  /**
   * Pipeline mode only. Phrase spoken when a turn opens with a tool call and
   * no speech. Defaults to `"One moment."`; set `""` to disable.
   */
  holdPhrase?: string;
  /**
   * Pipeline mode only. Phrase spoken when the turn's LLM stream fails, so the
   * caller hears something instead of silence. Defaults to
   * `"Sorry, I had a problem just then. Could you say that again?"`; set `""`
   * to disable.
   */
  errorPhrase?: string;
  /**
   * Pipeline mode only. Resume the interrupted reply when a barge-in turns
   * out to be false (no user turn commits within this many ms). Defaults to
   * 2000; 0 disables recovery.
   */
  falseInterruptionTimeoutMs?: number;
  /**
   * Pluggable STT provider. Must be set together with `llm` and `tts` to
   * enable pipeline mode; leave all three unset for S2S mode.
   */
  stt?: SttProvider;
  /**
   * Pluggable LLM provider (Vercel AI SDK `LanguageModel`). Must be set
   * together with `stt` and `tts` to enable pipeline mode.
   */
  llm?: LlmProvider;
  /**
   * Pluggable TTS provider. Must be set together with `stt` and `llm` to
   * enable pipeline mode.
   */
  tts?: TtsProvider;
  /**
   * Pluggable S2S provider descriptor. When set, overrides the implicit
   * AssemblyAI default. Mutually exclusive with the `stt`/`llm`/`tts`
   * pipeline triple.
   */
  s2s?: S2sProvider;
  /** Pluggable Vector backend. Falls back to platform default when omitted. */
  vector?: VectorProvider;
  /**
   * Outbound send channel (e.g. `slack()` from `@alexkroman1/aai/send`).
   * Registers the `send_message` builtin and allowlists the channel's host.
   */
  send?: SendProvider;
  /**
   * Hostnames this agent's own tool code may `fetch`. Required for outbound
   * requests from a deployed agent — see {@link AgentDef.allowedHosts}.
   */
  allowedHosts?: string[];
  /** Per-session mutable state factory, exposed to tools as `ctx.state`. */
  state?: () => Record<string, unknown>;
}): AgentDef {
  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    greeting: DEFAULT_GREETING,
    maxSteps: DEFAULT_MAX_STEPS,
    tools: {},
    ...def,
  };
}

/**
 * Define a workflow — the SDK's second mode, alongside `agent()`.
 *
 * Where an agent is a conversational chat/voice interface, a workflow is
 * **audio in, action out**: the user records one instruction (push to talk)
 * or uploads an audio file, presses go, a single agentic loop transcribes
 * it and executes the actions with the workflow's tools, and the run ends
 * with a written report. There is no conversation and no history between
 * runs.
 *
 * Compared to `agent()`:
 * - `stt` and `llm` are **required** (a workflow is always a pipeline);
 *   there is no `tts` — a workflow never speaks. Its output is actions
 *   plus a written report.
 * - The default system prompt is {@link DEFAULT_WORKFLOW_SYSTEM_PROMPT} —
 *   one-shot execution semantics (no clarifying questions, report the
 *   outcome) instead of the conversational agent default.
 * - The default client renders the workflow surface (record / upload + go)
 *   over the connectionless sync transport instead of a chat session.
 *
 * @example
 * ```ts
 * import { workflow, tool } from "@alexkroman1/aai";
 * import { assemblyAI } from "@alexkroman1/aai/stt";
 * import { anthropic } from "@alexkroman1/aai/llm";
 * import { z } from "zod";
 *
 * export default workflow({
 *   name: "Expense Filer",
 *   stt: assemblyAI({ model: "u3pro-rt" }),
 *   llm: anthropic({ model: "claude-sonnet-5" }),
 *   tools: {
 *     file_expense: tool({
 *       description: "File one expense",
 *       parameters: z.object({ amount: z.number(), memo: z.string() }),
 *       execute: async ({ amount, memo }, ctx) => {
 *         await ctx.db.query("insert into expenses (amount, memo) values ($1, $2)", [
 *           amount,
 *           memo,
 *         ]);
 *         return { filed: true, amount, memo };
 *       },
 *     }),
 *   },
 * });
 * ```
 *
 * @public
 */
export function workflow(def: {
  name: string;
  /** Instructions for the run. Defaults to {@link DEFAULT_WORKFLOW_SYSTEM_PROMPT}. */
  systemPrompt?: string;
  /** Idle-state instruction line shown by the default client. */
  greeting?: string;
  tools?: Record<string, ToolDef>;
  builtinTools?: BuiltinTool[];
  /** Max tool calls per run. Defaults to {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number;
  toolChoice?: ToolChoice;
  sttPrompt?: string;
  /** STT provider that transcribes the recorded/uploaded audio. Required. */
  stt: SttProvider;
  /** LLM that runs the agentic loop over the transcript. Required. */
  llm: LlmProvider;
  vector?: VectorProvider;
  send?: SendProvider;
  allowedHosts?: string[];
  /** Per-run mutable state factory, exposed to tools as `ctx.state`. */
  state?: () => Record<string, unknown>;
}): AgentDef {
  return {
    systemPrompt: DEFAULT_WORKFLOW_SYSTEM_PROMPT,
    greeting: DEFAULT_WORKFLOW_GREETING,
    maxSteps: DEFAULT_MAX_STEPS,
    tools: {},
    ...def,
    // A workflow never speaks — tts is not a parameter, always the sentinel.
    tts: none(),
    kind: "workflow",
  };
}
