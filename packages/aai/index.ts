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
  type BuiltinTool,
  defineAgent,
  defineTool,
  defineToolFactory,
  type HookContext,
  type Message,
  type Middleware,
  type MiddlewareBlockResult,
  type ToolCallInterceptResult,
  type ToolChoice,
  type ToolContext,
  type ToolDef,
  type ToolResultMap,
  tool,
} from "./types.ts";
