// Copyright 2025 the AAI authors. MIT license.
/**
 * Tool execution — validates arguments and invokes tool handlers.
 *
 * {@link executeToolCall} is the single entry point used by both the
 * direct (self-hosted) runtime and the platform sandbox sidecar.
 */

import pTimeout from "p-timeout";
import { EMPTY_PARAMS } from "../sdk/_internal-types.ts";
import { TOOL_EXECUTION_TIMEOUT_MS } from "../sdk/constants.ts";
import type { Db } from "../sdk/db.ts";
import { STORAGE_DISABLED_MESSAGE } from "../sdk/db.ts";
import { formatSchemaIssues } from "../sdk/schema.ts";
import type { Message, ToolContext, ToolDef } from "../sdk/types.ts";
import { errorDetail, errorMessage, toolError } from "../sdk/utils.ts";
import { WORKFLOWS_UNAVAILABLE_MESSAGE, type WorkflowClient } from "../sdk/workflow.ts";
import { type HostGenerateFn, toGenerateFn } from "./generate.ts";
import type { Logger } from "./runtime-config.ts";

export type { ExecuteTool, ExecuteToolOptions } from "../sdk/_internal-types.ts";

// setImmediate rather than setTimeout(0): same yield-to-I/O semantics without
// Node's ~1ms timer clamp — saves a couple of ms on every tool call.
const yieldTick = (): Promise<void> => new Promise((r) => setImmediate(r));

type ExecuteToolCallOptions = {
  tool: ToolDef;
  env: Readonly<Record<string, string>>;
  state?: Record<string, unknown>;
  sessionId?: string | undefined;
  db?: Db | undefined;
  messages?: readonly Message[] | undefined;
  /** Host LLM generation (ctx.generate); absent contexts throw on use. */
  generate?: HostGenerateFn | undefined;
  /** ctx.workflows; absent (no workflows declared, or no storage) rejects on use. */
  workflows?: WorkflowClient | undefined;
  logger?: Logger | undefined;
  send?: ((event: string, data: unknown) => void) | undefined;
  /** Turn-scoped cancellation: unblocks the await (and is exposed to the tool
   *  as `ctx.signal`) when the issuing turn is cancelled or the session stops. */
  signal?: AbortSignal | undefined;
};

// Takes the per-call signal as a REQUIRED narrowing of the options bag:
// `ExecuteToolCallOptions.signal` is the turn signal and is optional, but the
// context's signal is the per-call controller `executeToolCall` always builds,
// which is what makes `ToolContext.signal` non-optional.
/**
 * The `ctx.workflows` a context without an engine gets: every method rejects
 * with the same message, so dev and prod cannot describe the gap differently.
 */
const UNAVAILABLE_WORKFLOWS: WorkflowClient = {
  start: () => Promise.reject(new Error(WORKFLOWS_UNAVAILABLE_MESSAGE)),
  get: () => Promise.reject(new Error(WORKFLOWS_UNAVAILABLE_MESSAGE)),
};

function buildToolContext(opts: ExecuteToolCallOptions & { signal: AbortSignal }): ToolContext {
  const { env, state, db, messages, sessionId, send, signal, generate, workflows } = opts;
  return {
    env,
    state: state ?? {},
    signal,
    get db(): Db {
      if (!db) {
        throw new Error(STORAGE_DISABLED_MESSAGE);
      }
      return db;
    },
    // The per-call signal cancels an in-flight generation the same way it
    // unblocks the tool await. Bound through the shared forwarder in
    // host/generate.ts, which owns the one assertion the overloaded
    // `GenerateFn` needs — a workflow's context binds its own the same way.
    generate: toGenerateFn(generate, { signal }),
    // Absent when the agent declares no workflows or storage is off. A
    // rejecting client rather than a missing field: `ctx.workflows.start` is
    // reached from inside a tool body, where a `?.` on every call buys the
    // author nothing over an error that names the fix.
    workflows: workflows ?? UNAVAILABLE_WORKFLOWS,
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
  const { tool, logger } = options;
  const schema = tool.inputSchema ?? EMPTY_PARAMS;
  // The spec allows a sync or async validate; await normalizes both.
  const parsed = await schema["~standard"].validate(args);
  if (parsed.issues) {
    return toolError(`Invalid arguments for tool "${name}": ${formatSchemaIssues(parsed.issues)}`);
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
      return toolError(`Tool "${name}" was cancelled before it ran`);
    }
    // The signal makes the await settle promptly on barge-in/reset/stop; the
    // underlying execute keeps running unless it observes ctx.signal itself.
    const result = await pTimeout(Promise.resolve(tool.execute(parsed.value, ctx)), {
      milliseconds: TOOL_EXECUTION_TIMEOUT_MS,
      message: `Tool "${name}" timed out after ${TOOL_EXECUTION_TIMEOUT_MS}ms`,
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
    return toolError(errorMessage(err));
  } finally {
    // The turn signal outlives this call; drop the follower or every tool
    // call in the reply leaks a listener on it.
    turnSignal?.removeEventListener("abort", followTurn);
  }
}
