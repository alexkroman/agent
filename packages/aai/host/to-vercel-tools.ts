// Copyright 2025 the AAI authors. MIT license.
/**
 * Converts agent {@link ToolSchema}[] to Vercel AI SDK tools, delegating
 * `execute` to the agent's {@link ExecuteTool} so validation, KV, hooks,
 * and timeouts remain the single source of truth for tool behavior.
 */

import { jsonSchema, type Tool, type ToolExecutionOptions, tool } from "ai";
import type { ExecuteTool, ExecuteToolOptions, ToolSchema } from "../sdk/_internal-types.ts";
import type { Message } from "../sdk/types.ts";

export interface ToVercelToolsContext {
  executeTool: ExecuteTool;
  sessionId: string;
  messages: () => readonly Message[];
  signal?: AbortSignal;
}

export function toVercelTools(
  schemas: readonly ToolSchema[],
  ctx: ToVercelToolsContext,
): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const schema of schemas) {
    out[schema.name] = tool({
      description: schema.description,
      inputSchema: jsonSchema(schema.parameters),
      execute: async (args: unknown, options: ToolExecutionOptions<unknown>) => {
        const input = (args ?? {}) as Readonly<Record<string, unknown>>;
        // Per-call abortSignal from streamText takes precedence over bag-level
        // ctx.signal so individual invocations respect outer-turn aborts.
        const signal = options.abortSignal ?? ctx.signal;
        const opts: ExecuteToolOptions = {};
        if (signal !== undefined) opts.signal = signal;
        if (options.toolCallId !== undefined) opts.toolCallId = options.toolCallId;
        // Snapshot history so concurrent mutation from a newer turn can't
        // leak into this tool's view.
        const history = ctx.messages().slice();
        return ctx.executeTool(schema.name, input, ctx.sessionId, history, opts);
      },
    });
  }
  return out;
}
