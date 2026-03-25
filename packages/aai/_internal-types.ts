// Copyright 2025 the AAI authors. MIT license.
/**
 * Internal type definitions shared by server and CLI.
 *
 * Note: this module is for internal use only and should not be used directly.
 */

import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import type { BuiltinTool, ToolChoice, ToolDef } from "./types.ts";

/**
 * Serializable agent configuration sent over the wire.
 *
 * This is the JSON-safe subset of the agent definition that can be
 * transmitted between the worker and the host process via structured clone.
 */
export type AgentConfig = {
  name: string;
  instructions: string;
  greeting: string;
  sttPrompt?: string | undefined;
  maxSteps?: number | undefined;
  toolChoice?: ToolChoice | undefined;
  builtinTools?: readonly BuiltinTool[] | undefined;
  /** Default set of active tools. Can be overridden per-turn via `onBeforeStep`. */
  activeTools?: readonly string[] | undefined;
};

/**
 * Serialized tool schema sent over the wire.
 * `parameters` must be a valid JSON Schema object (with `type`, `properties`,
 * etc.) — the Vercel AI SDK wraps it via `jsonSchema()`.
 */
export type ToolSchema = {
  name: string;
  description: string;
  parameters: JSONSchema7;
};

/**
 * Request body for the deploy endpoint.
 *
 * Sent by the CLI to the server when deploying a bundled agent.
 */
export type DeployBody = {
  /** Env vars are optional at deploy time — set separately via `aai env add`. */
  env?: Readonly<Record<string, string>> | undefined;
  worker: string;
  /** Client build files keyed by relative path (e.g. "index.html", "assets/index-abc.js"). */
  clientFiles: Readonly<Record<string, string>>;
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
