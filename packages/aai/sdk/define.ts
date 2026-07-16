// Copyright 2025 the AAI authors. MIT license.

import type { z } from "zod";
import { DEFAULT_MAX_STEPS } from "./constants.ts";
import type {
  KvProvider,
  LlmProvider,
  S2sProvider,
  SttProvider,
  TtsProvider,
  VectorProvider,
} from "./providers.ts";
import {
  type AgentDef,
  type BuiltinTool,
  DEFAULT_GREETING,
  DEFAULT_SYSTEM_PROMPT,
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
  /** Pluggable KV backend. Falls back to platform default when omitted. */
  kv?: KvProvider;
  /** Pluggable Vector backend. Falls back to platform default when omitted. */
  vector?: VectorProvider;
}): AgentDef {
  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    greeting: DEFAULT_GREETING,
    maxSteps: DEFAULT_MAX_STEPS,
    tools: {},
    ...def,
  };
}
