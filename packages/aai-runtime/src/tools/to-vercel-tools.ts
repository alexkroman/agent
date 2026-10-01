// Copyright 2025 the AAI authors. MIT license.
/**
 * Converts agent {@link ToolSchema}[] to Vercel AI SDK tools, delegating
 * `execute` to `run-tool-call.ts` — the one tool-call core every transport
 * runs — so coercion, validation, tool context, hooks, and timeouts remain the
 * single source of truth for tool behavior.
 */

import type { Message } from "@alexkroman1/aai";
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { jsonSchema, type Tool, type ToolExecutionOptions, tool } from "ai";
import { compactRecordsForModel } from "../_compact-records.ts";
import { type FatalToolError, isFatalToolError } from "./error-policy.ts";
import type { ToolSpeechController } from "./messages-runner.ts";
import { runToolCall, type SettledToolCall, type ToolCallContext } from "./run-tool-call.ts";

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
  /**
   * Speaks the tool's `messages` — see `messages-runner.ts`.
   *
   * Here rather than in the stream-part handler because two of the four kinds
   * can only be done from inside the call: a `blocking` start has to hold
   * `execute` up, and `complete`/`failed` need the RESULT, which the
   * `tool-result` part carries only after the fact. Optional, and absent for
   * every caller that is not a voice turn — a text agent, a subagent and a
   * speculation have nobody to speak to.
   */
  toolSpeech?: ToolSpeechController;
  signal?: AbortSignal;
}

/**
 * What the MODEL is told about one tool — shared by {@link toVercelTools} and
 * {@link toDeclaredTools}, because a speculation's request has to carry exactly
 * the declarations the real one does.
 */
function declarationOf(schema: ToolSchema) {
  return { description: schema.description, inputSchema: jsonSchema(schema.parameters) };
}

export function toVercelTools(
  schemas: readonly ToolSchema[],
  ctx: ToVercelToolsContext,
): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  const hinted = new HintedModelCopies();
  const parameters = new Map(schemas.map((schema) => [schema.name, schema.parameters]));
  const core: ToolCallContext = {
    executeTool: ctx.executeTool,
    sessionId: ctx.sessionId,
    messages: ctx.messages,
    parameters: (name) => parameters.get(name),
    recordToolResult: ctx.recordToolResult,
  };
  for (const schema of schemas) {
    out[schema.name] = tool({
      ...declarationOf(schema),
      // The MODEL's copy of a result. `execute` returns the tool's own string,
      // because that is what the stream's `tool-result` part carries and a
      // `tool.completed` event is built from that part; the AI SDK asks this
      // for what the provider is sent. Rows are recomputed from the tool's own
      // string — the only copy that cannot be recomputed is one a tool message
      // hint was appended to, which `execute` keeps under the call's id.
      toModelOutput: ({ toolCallId, output }) => ({
        type: "text",
        value: hinted.get(toolCallId) ?? compactRecordsForModel(String(output)),
      }),
      execute: async (args: unknown, options: ToolExecutionOptions<unknown>) => {
        // The call itself — coercion, the history snapshot, execution, the
        // recorded result and the model's copy — is `run-tool-call.ts`'s, the
        // one core the S2S tool step runs too. What stays here is what only a
        // pipeline turn has: the tool's own voice and the fatal latch.
        const signal = options.abortSignal ?? ctx.signal;
        let speech: ReturnType<ToolSpeechController["begin"]> | undefined;
        let settled: SettledToolCall;
        try {
          settled = await runToolCall(
            {
              name: schema.name,
              args: (args ?? {}) as Readonly<Record<string, unknown>>,
              toolCallId: options.toolCallId,
              signal,
            },
            core,
            // The tool's own voice for the length of this call: the START line
            // (awaited only when it is `blocking`) and the delay ladder, both
            // stopped on every exit path below. It needs the COERCED input.
            async (input) => {
              speech = ctx.toolSpeech?.begin(schema.messages, schema.name, input, signal);
              await speech?.start();
            },
          );
        } catch (err: unknown) {
          speech?.dispose();
          // The ONE rejection `executeTool` produces (see its doc): a failure
          // the author declared unrecoverable. Announced before it is re-thrown,
          // because the throw itself goes nowhere useful — the AI SDK catches
          // it, emits a `tool-error` part and keeps stepping. Nothing was
          // recorded: what reaches here is a result the model is not given.
          if (isFatalToolError(err)) ctx.onFatalToolError?.(err);
          throw err;
        }
        // Stops the ladder and speaks the outcome. A `role: "system"` completion
        // annotates the result with its hint, which the model and the
        // `tool.completed` event both carry, while the history holds the tool's
        // OWN result — the same split the S2S arm makes on its failure path.
        // Record collections are rendered as rows in the MODEL's copy alone
        // (via `toModelOutput` above); the AI SDK keeps that copy in the step's
        // messages, so later turns read rows too.
        const { result, forModel: shaped } = settled;
        const forModel = speech?.settled(shaped) ?? shaped;
        // `settled` returns what it was given, or that with a hint APPENDED, so
        // the hint is the tail past `shaped` and goes after the tool's own
        // string just the same.
        const hint = forModel.slice(shaped.length);
        if (hint !== "" && shaped !== result) hinted.keep(options.toolCallId, forModel);
        return result + hint;
      },
    });
  }
  return out;
}

/**
 * Model copies that `toModelOutput` cannot recompute from the tool's own
 * string — rows AND a tool-message hint — keyed by tool call id.
 *
 * The AI SDK may ask for one call's model output more than once within the
 * step, so `get` reads without deleting; the tool set lives for a whole
 * session, so the store is capped instead. A call needs its entry only until
 * its step ends, and an evicted one degrades to rows without the hint.
 */
class HintedModelCopies {
  static readonly #CAP = 32;
  readonly #copies = new Map<string, string>();

  keep(toolCallId: string, copy: string): void {
    this.#copies.set(toolCallId, copy);
    if (this.#copies.size <= HintedModelCopies.#CAP) return;
    const oldest = this.#copies.keys().next().value;
    if (oldest !== undefined) this.#copies.delete(oldest);
  }

  get(toolCallId: string): string | undefined {
    return this.#copies.get(toolCallId);
  }
}

/**
 * The same tool declarations with NO `execute`, for a speculative LLM stream
 * (preemptive generation — see `transports/pipeline/speech/speculation.ts`).
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
    out[schema.name] = tool(declarationOf(schema));
  }
  return out;
}
