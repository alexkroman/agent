// Copyright 2025 the AAI authors. MIT license.
/**
 * Tool execution — validates arguments and invokes tool handlers.
 *
 * {@link executeToolCall} is the single entry point used by both the
 * direct (self-hosted) runtime and the platform sandbox sidecar.
 */

import type {
  DelegateFn,
  DelegateOptions,
  DelegateResult,
  GenerateFn,
  GenerateOptions,
  GenerateResult,
  Message,
  SlotStore,
  SubagentDef,
  ToolContext,
  ToolDef,
} from "@alexkroman1/aai";
import type { ExecuteTool, ExecuteToolOptions } from "@alexkroman1/aai/host-internal";
import {
  createDetachedSlotStore,
  EMPTY_PARAMS,
  serializeToolFailure,
} from "@alexkroman1/aai/host-internal";
import {
  formatSchemaIssues,
  rejectingWorkflows,
  TOOL_EXECUTION_TIMEOUT_MS,
  WORKFLOWS_UNAVAILABLE_MESSAGE,
} from "@alexkroman1/aai/internal";
import { errorDetail, errorMessage } from "@alexkroman1/aai/utils";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import pTimeout from "p-timeout";
import type { HostGenerateFn } from "./generate.ts";
import type { Logger } from "./runtime-config.ts";

export type { ExecuteTool, ExecuteToolOptions } from "@alexkroman1/aai/host-internal";

/**
 * Everything one tool call is given EXCEPT the tool — the bag a subagent's own
 * tools are run with, derived by subtraction so a capability added to a tool
 * context cannot be silently missing from a delegated one.
 *
 * @internal
 */
export type ToolCallDefaults = Omit<ExecuteToolCallOptions, "tool">;

/**
 * Run a subagent to completion (`ctx.delegate`) — implemented by
 * `createSubagentRunner` in `subagent.ts`, which is the only caller of
 * {@link executeToolCall} that passes a bag it did not build itself.
 *
 * Declared HERE rather than beside its implementation because
 * {@link ExecuteToolCallOptions} carries one and the two types are mutually
 * recursive: a delegated run's tools are ordinary tool calls, whose context
 * carries the runner again (refusing — delegation is one level deep).
 *
 * @internal
 */
export type SubagentRunner = (
  subagent: SubagentDef,
  options: DelegateOptions,
  parent: ToolCallDefaults,
) => Promise<DelegateResult>;

// setImmediate rather than setTimeout(0): same yield-to-I/O semantics without
// Node's ~1ms timer clamp — saves a couple of ms on every tool call.
const yieldTick = (): Promise<void> => new Promise((r) => setImmediate(r));

type ExecuteToolCallOptions = {
  tool: ToolDef;
  env: Readonly<Record<string, string>>;
  /**
   * This session's slot storage (`ctx.slots`). Absent for a sessionless caller,
   * which gets a detached one — see `buildToolContext`.
   */
  slots?: SlotStore | undefined;
  sessionId?: string | undefined;
  messages?: readonly Message[] | undefined;
  /** Host LLM generation (ctx.generate); absent contexts throw on use. */
  generate?: HostGenerateFn | undefined;
  /**
   * Host subagent runner (ctx.delegate); absent contexts reject on use.
   *
   * Passed as a FUNCTION rather than as the pieces one would need to build it,
   * because a delegated run re-enters {@link executeToolCall} with this same
   * bag — so what the runner needs from a tool call is exactly what a tool call
   * already has.
   */
  subagents?: SubagentRunner | undefined;
  logger?: Logger | undefined;
  /**
   * Report that `execute` THREW — as distinct from returning a `ToolFailure`.
   *
   * The distinction is the one `toolFailure`/`isToolFailure` exists to draw. A
   * returned failure is the author saying "this is expected, let the model
   * recover"; a throw is a bug, and until this existed a throw produced no
   * error frame, no client banner, no `error` session event, and one
   * `logger.warn` in a ring buffer that dies with the sandbox. `tool` is one of
   * the eight `SessionErrorCode` values and was emitted by NOTHING, so the
   * likeliest bug in a voice agent was also its least observable: what a caller
   * hears is the model improvising an apology around a serialized `TypeError`.
   *
   * Non-fatal by construction at the call sites — the turn continues, the model
   * still gets the failure, and the frame is for whoever is watching.
   */
  onUncaught?: ((message: string) => void) | undefined;
  send?: ((event: string, data: unknown) => void) | undefined;
  /** Turn-scoped cancellation: unblocks the await (and is exposed to the tool
   *  as `ctx.signal`) when the issuing turn is cancelled or the session stops. */
  signal?: AbortSignal | undefined;
  /**
   * Durable workflows (`ctx.workflows`). Absent contexts get a client whose
   * every method rejects naming the missing configuration — an app that declares
   * no workflows and one whose world is unset are both legitimately in that
   * state, and a tool that reaches for it deserves the reason rather than a
   * `TypeError` on `undefined.start`.
   */
  workflows?: WorkflowClient | undefined;
  /**
   * Per-call deadline. Defaults to `TOOL_EXECUTION_TIMEOUT_MS` (30s),
   * which is sized for a VOICE turn — past it the caller is listening to
   * silence, so a slow tool is already a failed turn.
   *
   * A text agent is the case that needs another number: nobody is holding a
   * phone, and its tools are the long ones (a package install, a type check,
   * a shell command). The studio coding agent ran its whole tool set behind a
   * 120s wrapper of its own before this existed.
   */
  timeoutMs?: number | undefined;
};

// Takes the per-call signal as a REQUIRED narrowing of the options bag:
// `ExecuteToolCallOptions.signal` is the turn signal and is optional, but the
// context's signal is the per-call controller `executeToolCall` always builds,
// which is what makes `ToolContext.signal` non-optional.
function buildToolContext(options: ExecuteToolCallOptions & { signal: AbortSignal }): ToolContext {
  const { env, slots, messages, sessionId, send, signal, generate, subagents, workflows } = options;
  return {
    env,
    // A caller with no session gets its own detached store rather than a shared
    // one: two such calls must not read each other's slots, which is the same
    // rule the `sessionId ?? randomUUID()` below encodes for the note builtins.
    slots: slots ?? createDetachedSlotStore(),
    signal,
    workflows: workflows ?? rejectingWorkflows(WORKFLOWS_UNAVAILABLE_MESSAGE),
    // Asserted rather than inferred, and this is the one place it happens.
    // `GenerateFn` is OVERLOADED: a Standard Schema call promises a required
    // `object`, which `createGenerateFn` does deliver (it runs `generateText`
    // with an `Output.object` spec and returns `{ text, object }`
    // unconditionally on that path). TypeScript
    // cannot check an overloaded signature against a single implementation, so
    // the forwarder is declared with the widest one and asserted here — the
    // narrowing is backed by host/generate.ts, not by hope.
    generate: ((genOpts: GenerateOptions): Promise<GenerateResult> => {
      if (!generate) {
        return Promise.reject(new Error("generate is not available in this execution context"));
      }
      // The per-call signal cancels an in-flight generation the same way it
      // unblocks the tool await. Passed unconditionally — it is always present
      // now that `ToolContext.signal` is.
      return generate(genOpts, { signal });
    }) as GenerateFn,
    // The runner is handed this call's whole option bag — MINUS the tool, which
    // is the one thing a delegated run supplies itself — plus the per-call
    // signal, so cancelling the turn cancels the subagent's loop and every tool
    // call inside it. `tool` is dropped by destructuring rather than by a cast:
    // a new option is then carried into a delegated run automatically, which is
    // the property `ToolCallDefaults` exists to keep.
    delegate: ((subagent: SubagentDef, delegateOpts: DelegateOptions): Promise<DelegateResult> => {
      if (!subagents) {
        return Promise.reject(new Error("delegate is not available in this execution context"));
      }
      const { tool: _tool, ...defaults } = options;
      return subagents(subagent, delegateOpts, { ...defaults, signal });
    }) satisfies DelegateFn,
    messages: messages ?? [],
    // No session → a unique per-call id, NOT "": the builtin remember/recall
    // notes are keyed by sessionId in a process-wide map, so sessionless
    // callers sharing the "" bucket would read each other's notes.
    sessionId: sessionId ?? crypto.randomUUID(),
    send(event: string, data: unknown): void {
      send?.(event, data);
    },
  };
}

function stringifyResult(result: unknown): string {
  if (result == null) return "null";
  if (typeof result === "string") return result;
  // JSON.stringify returns undefined for functions/symbols — fall back to
  // String() so the provider always gets a string, never `undefined`.
  return JSON.stringify(result) ?? String(result);
}

/**
 * Validate a tool call's arguments and invoke its handler, returning the
 * stringified (and capped) result.
 *
 * @internal
 */
export async function executeToolCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: ExecuteToolCallOptions,
): Promise<string> {
  const { tool, logger, onUncaught } = options;
  const schema = tool.inputSchema ?? EMPTY_PARAMS;
  // The spec allows a sync or async validate; await normalizes both.
  const parsed = await schema["~standard"].validate(args);
  if (parsed.issues) {
    return serializeToolFailure(
      `Invalid arguments for tool "${name}": ${formatSchemaIssues(parsed.issues)}`,
    );
  }

  // Per-call controller, exposed to the tool as ctx.signal. It follows the
  // turn signal AND fires when the call settles exceptionally — above all on
  // timeout, which the turn signal alone never covered: pTimeout only settles
  // the await, so a timed-out tool kept running (and kept mutating shared
  // ctx.state) after its error result was already committed to the turn, with
  // no way to even notice it had timed out.
  const turnSignal = options.signal;
  const callController = new AbortController();
  const followTurn = (): void => callController.abort(turnSignal?.reason);
  if (turnSignal?.aborted) followTurn();
  else turnSignal?.addEventListener("abort", followTurn, { once: true });

  try {
    const ctx = buildToolContext({ ...options, signal: callController.signal });
    await yieldTick();
    if (callController.signal.aborted) {
      return serializeToolFailure(`Tool "${name}" was cancelled before it ran`);
    }
    // The signal makes the await settle promptly on barge-in/reset/stop; the
    // underlying execute keeps running unless it observes ctx.signal itself.
    const timeoutMs = options.timeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS;
    const result = await pTimeout(Promise.resolve(tool.execute(parsed.value, ctx)), {
      milliseconds: timeoutMs,
      message: `Tool "${name}" timed out after ${timeoutMs}ms`,
      signal: callController.signal,
    });
    await yieldTick();
    return stringifyResult(result);
  } catch (err: unknown) {
    // The call is over (timeout or failure): fire the per-call signal so a
    // still-running execute can observe ctx.signal and stop its side effects.
    callController.abort(err);
    if (logger) {
      logger.warn("Tool execution failed", { tool: name, error: errorDetail(err) });
    } else {
      console.warn(`[tool-executor] Tool execution failed: ${name}`, err);
    }
    // The message names the TOOL, which the raw error never does: what reaches
    // the model is `errorMessage(err)` alone, so a bare "Cannot read properties
    // of undefined" was the whole diagnostic an author got for a bug in a file
    // this function knows the name of.
    onUncaught?.(`Tool "${name}" threw: ${errorMessage(err)}`);
    return serializeToolFailure(errorMessage(err));
  } finally {
    // The turn signal outlives this call; drop the follower or every tool
    // call in the reply leaks a listener on it.
    turnSignal?.removeEventListener("abort", followTurn);
  }
}

/**
 * One dispatched call, as {@link createToolDispatcher} hands it over.
 *
 * Not exported: both callers take it by inference, and nothing outside this
 * module names a dispatched call.
 */
type ToolCall = {
  name: string;
  args: Readonly<Record<string, unknown>>;
  /** `""` when the caller has no session — never `undefined`, so the run body cannot forget. */
  sessionId: string;
  messages?: readonly Message[] | undefined;
  options?: ExecuteToolOptions | undefined;
};

/**
 * The dispatcher shape every in-process tool path shares: look the name up, or
 * report an unknown one AS A TOOL RESULT.
 *
 * The lookup is two lines and was written twice — the self-hosted runtime
 * (`runtime-tools.ts`) and the text agent (`text-agent.ts`) — but what is
 * duplicated is a POLICY rather than a line count: an unknown name is a failure
 * the MODEL sees and can recover from, not a throw that fails the turn, and the
 * sentence it reads is part of that. Two copies is two places for one of those
 * to drift into the other kind of failure.
 *
 * Everything below the lookup stays with the caller, deliberately: the two
 * paths build genuinely different contexts (one has a live emitter, a slot
 * store and a commit point; the other has a detached store and a longer
 * deadline), and folding those into an options bag here would be one function
 * with two disjoint halves.
 *
 * @internal
 */
export function createToolDispatcher(
  tools: Readonly<Record<string, ToolDef>>,
  run: (tool: ToolDef, call: ToolCall) => Promise<string>,
): ExecuteTool {
  return (name, args, sessionId, messages, options) => {
    const tool = tools[name];
    if (!tool) return Promise.resolve(serializeToolFailure(`Unknown tool: ${name}`));
    return run(tool, { name, args, sessionId: sessionId ?? "", messages, options });
  };
}
