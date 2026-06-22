// Copyright 2025 the AAI authors. MIT license.
/**
 * Converts agent {@link ToolSchema}[] to Vercel AI SDK tools, delegating
 * `execute` to the agent's {@link ExecuteTool} so validation, KV, hooks,
 * and timeouts remain the single source of truth for tool behavior.
 */

import { jsonSchema, type Tool, type ToolExecutionOptions, tool } from "ai";
import type { ExecuteTool, ToolSchema } from "../sdk/_internal-types.ts";
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
  const { executeTool, sessionId, messages, signal: ctxSignal } = ctx;
  return Object.fromEntries(
    schemas.map((schema) => {
      const { name, description, parameters } = schema;
      return [
        name,
        tool({
          description,
          inputSchema: jsonSchema(parameters),
          execute: async (args: unknown, options: ToolExecutionOptions) => {
            const input = (args ?? {}) as Readonly<Record<string, unknown>>;
            // Snapshot history so concurrent mutation from a newer turn can't
            // leak into this tool's view.
            const history = messages().slice();
            // Per-call abortSignal from streamText takes precedence over
            // bag-level ctxSignal so individual invocations respect outer-turn aborts.
            const signal = options.abortSignal ?? ctxSignal;
            return executeTool(name, input, sessionId, history, {
              ...(signal !== undefined && { signal }),
              toolCallId: options.toolCallId,
            });
          },
        }),
      ];
    }),
  );
}
