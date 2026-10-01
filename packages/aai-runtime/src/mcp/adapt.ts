// Copyright 2026 the AAI authors. MIT license.
/**
 * A discovered MCP tool, adapted into an ordinary `ToolDef` — and a
 * `tools/call` reply into the value the model sees.
 *
 * Split from `tools.ts`, whose module doc argues why an MCP tool is an
 * ordinary tool rather than an AI SDK tool handed to `streamText`.
 */

import type { ToolDef } from "@alexkroman1/aai";
import { errorMessage, toolFailure } from "@alexkroman1/aai/utils";
import type { Tool, ToolSet } from "ai";
import type { JSONSchema7 } from "json-schema";
import { type McpCallResult, toCallResult } from "./connect.ts";
import { mcpInputSchema, toolInputJsonSchema } from "./schema.ts";

/**
 * Turn one `tools/call` reply into the value the model sees.
 *
 * Four outcomes, and the ordering between them is the decision: the server's
 * own `isError` wins over everything (it means the tool RAN and went wrong, so
 * the model should recover rather than read a half-answer), then structured
 * output when the server published a schema for it, then text — with any
 * non-text parts NAMED rather than dropped, because a server answering with an
 * image only would otherwise look like a tool that returned nothing.
 */
export function toToolResult(call: McpCallResult, toolName: string): unknown {
  if (call.isError) {
    return toolFailure(call.text || `${toolName} failed and the server sent no message`);
  }
  if (call.structured) return call.structured;
  if (call.otherParts.length > 0) {
    return { text: call.text, unsupportedContent: call.otherParts };
  }
  return call.text;
}

/** One discovered tool, as `tools.ts`'s `registerTools` reads it. */
export type DiscoveredTool = {
  /** The name the SERVER published — the key of the `ToolSet`. */
  remote: string;
  /** The AI SDK tool, whose `execute` this delegates to. */
  tool: Tool;
  /** The tool's resolved input JSON Schema, already awaited. */
  parameters: JSONSchema7;
  /** The tool's `execute`, narrowed once so the `ToolDef` body need not re-check. */
  call: NonNullable<Tool["execute"]>;
};

/** Build the `ToolDef` for one discovered tool. */
export function mcpTool(found: DiscoveredTool, serverKey: string, name: string): ToolDef {
  const described = found.tool.description ?? `The "${found.remote}" tool`;
  return {
    // The origin is in the description as well as in the name. The name already
    // carries it, but the description is what the model reasons over, and
    // "which of these tools is a third party's" is exactly the distinction an
    // author wants a model to be able to make.
    description: `${described} (via the "${serverKey}" MCP server)`,
    inputSchema: mcpInputSchema(found.parameters, name),
    async execute(args, ctx) {
      try {
        // `toolCallId`, `messages` and `context` are required by the AI SDK's
        // options type and read by nothing on this path — an MCP tool's
        // `execute` uses the abort signal and nothing else. They are filled
        // honestly rather than from our own `ctx.messages`, which is a
        // different message type and would be a lie about what the model saw.
        const result = await found.call(args, {
          toolCallId: crypto.randomUUID(),
          messages: [],
          context: {},
          abortSignal: ctx.signal,
        });
        return toToolResult(toCallResult(result), name);
      } catch (cause) {
        // A transport failure is the MODEL's problem to route around, not the
        // turn's to fail on: the session is live, every other tool still works,
        // and a voice agent can say it could not reach the thing. Returned
        // rather than rethrown for the reason every builtin returns `{ error }`.
        return toolFailure(
          `${name} could not reach the "${serverKey}" MCP server: ${errorMessage(cause)}`,
        );
      }
    },
  };
}

/**
 * Read one connected server's listing into the shape the registry walks.
 *
 * A tool with no `execute` is skipped: `ToolSet` types it optional (a
 * provider-executed tool has none), and an MCP tool without one is a tool this
 * runtime could declare to the model and then be unable to call.
 */
export async function discover(tools: ToolSet): Promise<DiscoveredTool[]> {
  const found: DiscoveredTool[] = [];
  for (const [remote, tool] of Object.entries(tools)) {
    const call = tool.execute;
    if (typeof call !== "function") continue;
    found.push({ remote, tool, call, parameters: await toolInputJsonSchema(tool) });
  }
  return found;
}
