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
import { toolResultMessage } from "./_tool-result-message.ts";
import { coerceToolArgs } from "./tool-arg-coercion.ts";
import { type FatalToolError, isFatalToolError } from "./tool-error-policy.ts";

interface ToVercelToolsContext {
  executeTool: ExecuteTool;
  sessionId: string;
  messages: () => readonly Message[];
  /**
   * Where a settled call's own result goes, so the NEXT tool call can read it
   * through `ctx.messages`.
   *
   * This is the one moment in the loop at which a tool result is known to the
   * host — the AI SDK hands the string straight back to the model and the
   * assistant/`tool` message pair only materializes at the end of the step —
   * so a caller that wants tool results in its conversation view has to be
   * told here or wait a whole step for them. Optional because two callers
   * legitimately do not: a speculation has no history to write into (it uses
   * {@link toDeclaredTools}, which has no `execute` at all), and
   * `TextAgent.tools` is bound to no conversation.
   */
  recordToolResult?: (message: Message) => void;
  /**
   * A tool declared its own failure UNRECOVERABLE — see {@link FatalToolLatch}.
   *
   * The rejection still propagates (the AI SDK needs it to stop treating the
   * call as pending), and it is still swallowed by the SDK's own tool-error
   * handling; this is the side channel that lets the turn find out. Without it
   * a fatal failure was indistinguishable, from outside `executeTool`, from any
   * other throw — the model got a `tool-error` part the pipeline drops on its
   * `default:` arm and went on stepping.
   *
   * Optional because two callers have no turn to stop: `toDeclaredTools` has no
   * `execute` at all, and `TextAgent.tools` is bound to no run.
   */
  onFatalToolError?: (error: FatalToolError) => void;
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
        const executeOptions: ExecuteToolOptions = {};
        if (signal !== undefined) executeOptions.signal = signal;
        // The AI SDK declares `toolCallId` required, so this guard is dead by
        // the vendor's own types — kept because it is the vendor's claim about
        // its runtime, not ours, and `ExecuteToolOptions.toolCallId` is
        // optional under `exactOptionalPropertyTypes`.
        if (options.toolCallId !== undefined) executeOptions.toolCallId = options.toolCallId;
        // Snapshot history so concurrent mutation from a newer turn can't
        // leak into this tool's view.
        const history = ctx.messages().slice();
        let result: string;
        try {
          result = await ctx.executeTool(
            schema.name,
            input,
            ctx.sessionId,
            history,
            executeOptions,
          );
        } catch (err: unknown) {
          // The ONE rejection `executeTool` produces (see its doc): a failure
          // the author declared unrecoverable. Announced before it is re-thrown,
          // because the throw itself goes nowhere useful — the AI SDK catches
          // it, emits a `tool-error` part and keeps stepping.
          if (isFatalToolError(err)) ctx.onFatalToolError?.(err);
          throw err;
        }
        // AFTER the call, so a tool never reads its own result back, and in
        // COMPLETION order, which is the only order that is true: the loop runs
        // a step's calls concurrently, so two siblings finishing out of issue
        // order really did finish that way and a later call reading them wants
        // what happened, not what was asked for.
        //
        // A throw skips this deliberately. `executeTool` resolves with a
        // serialized failure for anything the MODEL should see and recover
        // from, so what reaches here as a rejection is the executor itself
        // failing — a result the model is not given either.
        ctx.recordToolResult?.(
          toolResultMessage({
            result,
            toolName: schema.name,
            toolCallId: options.toolCallId,
          }),
        );
        return result;
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
