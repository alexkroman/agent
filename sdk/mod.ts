// Copyright 2025 the AAI authors. MIT license.
/**
 * AAI SDK — build voice agents powered by STT, LLM, and TTS.
 *
 * @example
 * ```ts
 * import { defineAgent } from "aai";
 * import { z } from "zod";
 *
 * export default defineAgent({
 *   name: "my-agent",
 *   instructions: "You are a helpful voice assistant.",
 *   tools: {
 *     greet: {
 *       description: "Greet the user by name",
 *       parameters: z.object({ name: z.string() }),
 *       execute: ({ name }) => `Hello, ${name}!`,
 *     },
 *   },
 * });
 * ```
 *
 * @module
 */

export { defineAgent } from "./define_agent.ts";
export type {
  AgentOptions,
  BeforeStepResult,
  HookContext,
  Message,
  PipelineMode,
  ToolContext,
  ToolDef,
} from "./types.ts";
