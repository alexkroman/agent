// Copyright 2025 the AAI authors. MIT license.
/**
 * Internal shared types and tool-schema conversion helpers.
 *
 * The public half of what used to live here — `AgentConfig` and its schema,
 * `toAgentConfig`, `ToolSchema`, `ExecuteTool` — moved to `agent-config.ts`
 * (a real, non-underscore module, so it renders under a proper name in the
 * docs). The names are re-exported below so every existing importer keeps
 * working unchanged.
 *
 * @internal
 */

import { z } from "zod";
import { omitUndefined } from "./omit-undefined.ts";
import { toToolJsonSchema } from "./schema.ts";
import { normalizeToolMessages } from "./tool-messages.ts";
import type { ToolSchema } from "./tool-schema.ts";
import type { ToolDef } from "./types.ts";

export {
  type AgentConfig,
  AgentConfigSchema,
  type AgentConfigSource,
  type ExecuteTool,
  type ExecuteToolOptions,
  type HostOnlyAgentField,
  toAgentConfig,
} from "./agent-config.ts";
export { type ToolSchema, ToolSchemaSchema } from "./tool-schema.ts";

export const EMPTY_PARAMS = z.object({});

export function agentToolsToSchemas(tools: Readonly<Record<string, ToolDef>>): ToolSchema[] {
  return Object.entries(tools).map(([name, def]) => {
    // TypeScript catches this rename; an untypechecked JS agent would
    // otherwise silently ship a no-arg tool spec.
    if ("parameters" in def && def.inputSchema === undefined) {
      throw new Error(
        `Tool "${name}" uses the removed \`parameters\` field — rename it to \`inputSchema\`.`,
      );
    }
    // Normalized HERE, once, at the only crossing from an author's `ToolDef`
    // to the wire declaration — so the runtime reads one shape and never the
    // shorthands, and `omitUndefined` keeps the key off a tool that declares
    // nothing (an ordinary tool's schema is unchanged by this field existing).
    const messages = normalizeToolMessages(def.messages);
    return {
      type: "function",
      name,
      description: def.description,
      ...omitUndefined({ messages }),
      // `"input"`, not the conversion default: this document is part of the
      // prompt a model is given, describing what it SENDS. A `.default()` field
      // is one the executor fills in when the call omits it (see
      // `executeToolCall`, which validates through this same schema), so
      // advertising it as `required` tells the model to ask the user for a
      // value the tool already has. See `toToolJsonSchema`'s doc for the other
      // properties the direction moves.
      parameters: toToolJsonSchema(def.inputSchema ?? EMPTY_PARAMS, "input"),
      // OMITTED rather than set to `undefined` when undeclared, because
      // `ToolSchemaSchema` is what a stored config round-trips through and a
      // `{ mutates: undefined }` survives a `structuredClone` and not a JSON
      // hop. The same rule `toolResultMessage` applies to `toolName`.
      ...omitUndefined({ mutates: def.mutates, completes: def.completes }),
    };
  });
}
