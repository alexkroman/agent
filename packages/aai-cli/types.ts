// Copyright 2025 the AAI authors. MIT license.
/**
 * User-facing type re-exports from the aai package.
 *
 * Agent projects depend on aai-cli (devDependency) and can
 * import shared types from this entry point.
 */

export type {
  AgentDef,
  BuiltinTool,
  Kv,
  Message,
  ToolChoice,
  ToolContext,
  ToolDef,
  ToolResultMap,
} from "aai";
