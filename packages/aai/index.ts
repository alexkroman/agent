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
 */

export type { Kv, KvEntry, KvListOptions } from "./kv.ts";
export {
  type AgentDef,
  type AgentOptions,
  type BeforeStepResult,
  type BuiltinTool,
  createToolFactory,
  defineAgent,
  defineTool,
  type HookContext,
  type Message,
  type Middleware,
  type MiddlewareBlockResult,
  type StepInfo,
  type ToolCallInterceptResult,
  type ToolChoice,
  type ToolContext,
  type ToolDef,
  tool,
} from "./types.ts";
export type { VectorEntry, VectorStore } from "./vector.ts";
