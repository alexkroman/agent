// Copyright 2025 the AAI authors. MIT license.
/**
 * Converts agent {@link ToolSchema}[] to Vercel AI SDK tools, delegating
 * `execute` to the agent's {@link ExecuteTool} so validation, tool context,
 * hooks, and timeouts remain the single source of truth for tool behavior.
 */

import type { Message } from "@alexkroman1/aai";
import type { ExecuteTool, ExecuteToolOptions } from "@alexkroman1/aai/host-internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { jsonSchema, type Tool, type ToolExecutionOptions, tool } from "ai";
import { coerceToolArgs } from "./tool-arg-coercion.ts";

interface ToVercelToolsContext {
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
        // Repair stringified scalars ("1500", "true") toward the schema's
        // declared types before the tool (or a relay observer) sees them.
        const input = coerceToolArgs(
          (args ?? {}) as Readonly<Record<string, unknown>>,
          schema.parameters,
        );
        // Per-call abortSignal from streamText takes precedence over bag-level
        // ctx.signal so individual invocations respect outer-turn aborts.
        const signal = options.abortSignal ?? ctx.signal;
        const opts: ExecuteToolOptions = {};
        if (signal !== undefined) opts.signal = signal;
        // The AI SDK declares `toolCallId` required, so this guard is dead by
        // the vendor's own types — kept because it is the vendor's claim about
        // its runtime, not ours, and `ExecuteToolOptions.toolCallId` is
        // optional under `exactOptionalPropertyTypes`.
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

/**
 * The same tool declarations with NO `execute`, for a speculative LLM stream
 * (preemptive generation — see `transports/pipeline-speculation.ts`).
 *
 * **The ABSENCE of the property is the guardrail, not a flag.** A speculation
 * runs from an interim transcript the caller may still be revising, so it must
 * never have a side effect; making that a runtime check would put the whole
 * guarantee on a branch someone can invert. The AI SDK cannot continue past a
 * tool call it has no way to execute, so a speculation is at most one step and
 * ends at the tool boundary — there is no code path from here to
 * {@link ExecuteTool}.
 *
 * The declarations must still be present and identical: the tool set is part of
 * the request, and a speculation run without tools would be a different request
 * from the real one, which is exactly what makes adoption illegitimate.
 */
export function toDeclaredTools(schemas: readonly ToolSchema[]): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const schema of schemas) {
    out[schema.name] = tool({
      description: schema.description,
      inputSchema: jsonSchema(schema.parameters),
    });
  }
  return out;
}
