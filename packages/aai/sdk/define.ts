// Copyright 2025 the AAI authors. MIT license.
/**
 * Helper functions for defining agents and tools with full type inference.
 */

import type { z } from "zod";
import type { LlmProvider, SttProvider, TtsProvider } from "./providers.ts";
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
}): AgentDef {
  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    greeting: DEFAULT_GREETING,
    maxSteps: 5,
    tools: {},
    ...def,
  };
}
