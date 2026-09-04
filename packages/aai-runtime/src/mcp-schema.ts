// Copyright 2026 the AAI authors. MIT license.
/**
 * An MCP tool's JSON Schema, worn as the `inputSchema` this runtime's tool
 * executor already knows how to read.
 *
 * `@ai-sdk/mcp` hands back tools in the AI SDK's own `Tool` shape, whose
 * `inputSchema` is a `FlexibleSchema` — for a discovered MCP tool, a
 * `jsonSchema(...)` wrapper around the document the server published. Our tool
 * executor validates through Standard Schema and builds the model's tool
 * declaration through `toToolJsonSchema`, which accepts any Standard Schema
 * that ALSO exposes a `toJsonSchema()` method (that duck-type is how ArkType
 * gets in). This is the adapter between the two.
 *
 * A typed seam rather than a cast at each tool: a concentration of identical
 * casts is a missing seam, and the alternative was one per discovered tool.
 *
 * ## Why the tools go through `ExecuteTool` at all
 *
 * The AI SDK tools `createMCPClient` returns would drop straight into
 * `streamText`, and that is exactly what this does NOT do. `to-vercel-tools.ts`
 * exists so that validation, the tool context, the per-call deadline, the
 * abort signal, the state commit and the relay observer have ONE
 * implementation; a tool set handed to `streamText` beside it would have none
 * of them, and "MCP tools behave differently from every other tool" is a much
 * worse property than one adapter module. So a discovered tool becomes a
 * `ToolDef` whose `execute` calls the AI SDK tool's, and the schema comes with
 * it.
 *
 * ## Why the document is passed through untouched
 *
 * It is what the MODEL reads. Re-deriving it (parse to zod, convert back) is
 * lossy in both directions — `format`, `$defs`, vendor keywords, enum
 * descriptions — and the loss shows up as the model calling the tool wrong,
 * which is indistinguishable from the server being bad. The only edits are the
 * AI SDK's own (`properties: {}` and `additionalProperties: false` are filled
 * in by `toolsFromDefinitions`) and the `$schema` strip `toToolJsonSchema` does
 * for every vendor.
 *
 * ## Why validation is a SHAPE check and not the schema
 *
 * `z.fromJSONSchema` exists (zod 4.5) and was the obvious move. It is ruled out
 * for two reasons that agree. Zod documents it as semi-experimental with
 * behaviour "liable to change", and the failure mode of a converter subtly
 * STRICTER than the source is a legitimate tool call refused before it leaves
 * the process — a silent capability loss whose only symptom is an agent that
 * will not do the thing. And it is not needed: the MCP server validates its own
 * arguments, because it is a remote API and has to, and its complaint comes
 * back as an `isError` result that `mcp-tools.ts` turns into a `ToolFailure`
 * the model can act on. Validating twice against two different readings of one
 * document buys a worse error, not a safer call.
 *
 * What is left for this side is the check the executor's own contract needs and
 * the server cannot make on our behalf: the arguments must be an OBJECT. A
 * provider that emits a bare string or an array for a tool call would otherwise
 * reach `callTool` and be refused by the transport with a JSON-RPC error about
 * a field name, several layers from the cause.
 *
 * The consequence to know about: a call with a missing required argument
 * reaches the server. That is a REMOTE round trip spent on a call that could
 * have been refused here, and the model sees the server's wording rather than
 * this SDK's. Both are accepted; neither is silent.
 */

import type { ToolInputSchema } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";
import { asSchema, type Tool } from "ai";
import type { JSONSchema7 } from "json-schema";

/**
 * What `mcp-tools.ts` puts in a `ToolDef.inputSchema`.
 *
 * Both halves are named in the type because both are load-bearing:
 * `~standard` is what `executeToolCall` validates through, and `toJsonSchema`
 * is what `agentToolsToSchemas` reads to build the declaration the model sees.
 * A change that drops either one fails here rather than at the first turn.
 */
export type McpInputSchema = ToolInputSchema & {
  toJsonSchema(): JSONSchema7;
};

/** The vendor name this adapter reports, and the one its issues are read under. */
export const MCP_SCHEMA_VENDOR = "aai-mcp";

/**
 * The JSON Schema behind an AI SDK tool's `inputSchema`.
 *
 * `asSchema` normalizes the four shapes a `FlexibleSchema` can be (and an
 * absent one, which becomes the empty object schema) — and its `jsonSchema` is
 * declared as possibly a promise, because the AI SDK supports deferring a
 * conversion. Awaiting it here is what lets {@link mcpInputSchema} stay
 * synchronous, which matters: `agentToolsToSchemas` converts on the way to the
 * model and cannot await.
 */
export async function toolInputJsonSchema(tool: Tool): Promise<JSONSchema7> {
  return await asSchema(tool.inputSchema).jsonSchema;
}

/**
 * Wrap one MCP tool's published JSON Schema as an `inputSchema`.
 *
 * @param toolName - Used only in the issue message, so a rejected call names
 *   the tool the model actually called rather than "the input".
 */
export function mcpInputSchema(parameters: JSONSchema7, toolName: string): McpInputSchema {
  return {
    "~standard": {
      version: 1,
      vendor: MCP_SCHEMA_VENDOR,
      validate: (value: unknown) =>
        isRecord(value)
          ? { value }
          : {
              issues: [
                {
                  message: `${toolName} takes an object of arguments; the model sent ${value === null ? "null" : typeof value}`,
                },
              ],
            },
    },
    toJsonSchema: () => parameters,
  };
}
