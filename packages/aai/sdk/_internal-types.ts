// Copyright 2025 the AAI authors. MIT license.
/**
 * Internal type definitions shared by server and CLI.
 *
 * Note: this module is for internal use only and should not be used directly.
 */

import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import type { Message } from "./types.ts";
import { BuiltinToolSchema, ToolChoiceSchema, type ToolDef } from "./types.ts";

/**
 * Options forwarded to an {@link ExecuteTool} invocation.
 *
 * Primarily used by the pipeline orchestrator (streamText tool loop) to
 * thread an {@link AbortSignal} into tool execution. The S2S voice path
 * does not pass these options today — recipients must treat the whole
 * bag as optional.
 */
export interface ExecuteToolOptions {
  /** Abort signal bound to the enclosing LLM turn / request. */
  signal?: AbortSignal;
  /** Vercel AI SDK tool-call ID for this invocation. Useful for tracing and correlation. */
  toolCallId?: string;
}

/**
 * Function signature for executing a tool by name.
 *
 * Used by session.ts to invoke tools, by direct-executor.ts and
 * harness-runtime.ts to implement the execution.
 */
export type ExecuteTool = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  sessionId?: string,
  messages?: readonly Message[],
  opts?: ExecuteToolOptions,
) => Promise<string>;

// ─── AgentConfig ────────────────────────────────────────────────────────────

/**
 * Zod schema for serializable agent configuration sent over the wire.
 *
 * This is the JSON-safe subset of the agent definition that can be
 * transmitted between the worker and the host process via structured clone.
 */
export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string(),
  greeting: z.string(),
  sttPrompt: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
  toolChoice: ToolChoiceSchema.optional(),
  builtinTools: z.array(BuiltinToolSchema).readonly().optional(),
  idleTimeoutMs: z.number().nonnegative().optional(),
});

/** Serializable agent configuration — derived from {@link AgentConfigSchema}. */
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Input shape accepted by {@link toAgentConfig}. Covers both `AgentDef`
 * (where `maxSteps` may be a function) and `IsolateConfig` (where it is
 * always a number).
 */
export interface AgentConfigSource {
  name: string;
  systemPrompt: string;
  greeting: string;
  sttPrompt?: string | undefined;
  maxSteps?: number | undefined;
  toolChoice?: AgentConfig["toolChoice"] | undefined;
  builtinTools?: Readonly<AgentConfig["builtinTools"]> | undefined;
  idleTimeoutMs?: number | undefined;
}

/** Extract the serializable {@link AgentConfig} subset from a source object. */
export function toAgentConfig(src: AgentConfigSource): AgentConfig {
  const config: AgentConfig = {
    name: src.name,
    systemPrompt: src.systemPrompt,
    greeting: src.greeting,
  };
  if (src.sttPrompt !== undefined) config.sttPrompt = src.sttPrompt;
  if (src.maxSteps !== undefined) config.maxSteps = src.maxSteps;
  if (src.toolChoice !== undefined) config.toolChoice = src.toolChoice;
  if (src.builtinTools) config.builtinTools = [...src.builtinTools];
  if (src.idleTimeoutMs !== undefined) config.idleTimeoutMs = src.idleTimeoutMs;
  return config;
}

// ─── ToolSchema ─────────────────────────────────────────────────────────────

/**
 * Zod schema for serialized tool definitions sent over the wire.
 *
 * `parameters` must be a valid JSON Schema object (with `type`, `properties`,
 * etc.) — the Vercel AI SDK wraps it via `jsonSchema()`.
 */
export const ToolSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

/** Serialized tool schema — derived from {@link ToolSchemaSchema}. */
export type ToolSchema = {
  name: string;
  description: string;
  parameters: JSONSchema7;
};

/** Empty Zod object schema used as default when tools have no parameters. */
export const EMPTY_PARAMS = z.object({});

/**
 * Convert agent tool definitions to JSON Schema format for wire transport.
 *
 * Transforms the Zod-based `parameters` of each tool into a plain JSON Schema
 * object suitable for structured clone / JSON serialization.
 */
export function agentToolsToSchemas(tools: Readonly<Record<string, ToolDef>>): ToolSchema[] {
  return Object.entries(tools).map(([name, def]) => ({
    name,
    description: def.description,
    parameters: z.toJSONSchema(def.parameters ?? EMPTY_PARAMS) as JSONSchema7,
  }));
}
