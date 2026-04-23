// Copyright 2025 the AAI authors. MIT license.
/**
 * Converts agent {@link ToolSchema}[] to Vercel AI SDK tools with `execute`
 * delegation to the agent's {@link ExecuteTool} function.
 *
 * The pipeline orchestrator passes the output to `streamText({ tools })`.
 * Each produced tool's `execute` closure calls
 * `ctx.executeTool(name, args, sessionId, messages(), { signal, toolCallId })`,
 * so the existing agent tool infrastructure (argument validation, KV, hooks,
 * timeout) remains the single source of truth for tool behavior.
 *
 * Per-call `options.abortSignal` (forwarded by `streamText` when the
 * outer turn is aborted, e.g. barge-in) takes precedence over the
 * bag-level `ctx.signal` so individual invocations respect streamText
 * aborts.
 */

import { jsonSchema, type Tool, type ToolExecutionOptions, tool } from "ai";
import type { ExecuteTool, ExecuteToolOptions, ToolSchema } from "../sdk/_internal-types.ts";
import type { Message } from "../sdk/types.ts";

export interface ToVercelToolsContext {
  /** The agent's tool-execution function (from the runtime). */
  executeTool: ExecuteTool;
  /** Session id threaded to {@link executeTool}. */
  sessionId: string;
  /**
   * Returns the current conversation history at call-time. The orchestrator
   * calls this per invocation; `toVercelTools` snapshots the returned array
   * before forwarding to `executeTool` so concurrent mutations cannot leak
   * across tool calls.
   */
  messages: () => readonly Message[];
  /**
   * Bag-level abort signal. Used as a fallback when the per-call
   * `options.abortSignal` from Vercel's `ToolExecutionOptions` is absent.
   */
  signal?: AbortSignal;
}

/**
 * Convert an array of {@link ToolSchema} to a Vercel AI SDK `ToolSet`
 * (record keyed by tool name).
 *
 * Uses the v6 `tool()` helper with `inputSchema: jsonSchema(...)` wrapping
 * the agent's JSON Schema `parameters`. Execution is delegated to
 * `ctx.executeTool` so validation, KV, timeouts, and hooks keep working.
 */
export function toVercelTools(
  schemas: readonly ToolSchema[],
  ctx: ToVercelToolsContext,
): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const schema of schemas) {
    out[schema.name] = tool({
      description: schema.description,
      inputSchema: jsonSchema(schema.parameters),
      execute: async (args: unknown, options: ToolExecutionOptions) => {
        const input = (args ?? {}) as Readonly<Record<string, unknown>>;
        // Prefer the per-call abortSignal forwarded by streamText over the
        // bag-level ctx.signal so individual invocations respect aborts.
        const signal = options.abortSignal ?? ctx.signal;
        const opts: ExecuteToolOptions = {};
        if (signal !== undefined) opts.signal = signal;
        if (options.toolCallId !== undefined) opts.toolCallId = options.toolCallId;
        // Snapshot the messages array so concurrent mutation (e.g. a new
        // turn starting after this one was aborted) can't leak into this
        // tool's view of history.
        return ctx.executeTool(schema.name, input, ctx.sessionId, ctx.messages().slice(), opts);
      },
    });
  }
  return out;
}
