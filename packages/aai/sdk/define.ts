// Copyright 2025 the AAI authors. MIT license.

import type { z } from "zod";
import { DEFAULT_MAX_STEPS } from "./constants.ts";
import {
  type AgentDef,
  DEFAULT_GREETING,
  DEFAULT_SYSTEM_PROMPT,
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
 * Input type for the {@link agent} helper.
 *
 * All fields from {@link AgentDef} are optional except `name`. The `agent()`
 * function fills in `systemPrompt`, `greeting`, `maxSteps`, and `tools` when
 * they are omitted.
 *
 * @public
 */
export type AgentOptions = Partial<AgentDef> & { name: string };

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
export function agent(def: AgentOptions): AgentDef {
  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    greeting: DEFAULT_GREETING,
    maxSteps: DEFAULT_MAX_STEPS,
    tools: {},
    ...def,
  };
}
