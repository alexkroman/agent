// Copyright 2025 the AAI authors. MIT license.
/**
 * Tool execution — validates arguments and invokes tool handlers.
 *
 * {@link executeToolCall} is the single entry point used by both the
 * direct (self-hosted) runtime and the platform sandbox sidecar.
 *
 * **It answers with a string on almost every path, and REJECTS on exactly
 * one.** Bad arguments, an unknown tool, a cancelled call, a deadline and an
 * ordinary throw all come back as a result the model reads, because the model
 * is the one who can do something about them. The exception is a tool whose
 * {@link ToolDef.onError} threw: the author has declared that failure
 * unrecoverable, so there is nothing to hand back and the call rejects with a
 * `FatalToolError`. `error-policy.ts` owns which is which.
 */

import type {
  DelegateFn,
  DelegateOptions,
  DelegateResult,
  GenerateFn,
  GenerateOptions,
  GenerateResult,
  Message,
  SessionSpeech,
  SlotStore,
  SpeakerDef,
  ToolContext,
  ToolDef,
  Toolset,
} from "@alexkroman1/aai";
import type { ExecuteTool, ExecuteToolOptions } from "@alexkroman1/aai/host-internal";
import {
  createDetachedSlotStore,
  DETACHED_SESSION_SPEECH,
  EMPTY_PARAMS,
  formatSchemaIssues,
  serializeToolFailure,
} from "@alexkroman1/aai/host-internal";
import {
  bindClientToolCall,
  type ClientToolCall,
  rejectingWorkflows,
  TOOL_EXECUTION_TIMEOUT_MS,
  WORKFLOWS_UNAVAILABLE_MESSAGE,
} from "@alexkroman1/aai/internal";
import { composeToolsets } from "@alexkroman1/aai/manifest";
import { errorDetail, errorMessage } from "@alexkroman1/aai/utils";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import pTimeout, { TimeoutError } from "p-timeout";
import type { HostGenerateFn } from "../generate.ts";
import type { Logger } from "../logger.ts";
import type { UsageMeter } from "../usage-meter.ts";
import { resolveToolError } from "./error-policy.ts";
import { stringifyResult, warnOversizedResult } from "./result-text.ts";

export type { ExecuteTool, ExecuteToolOptions } from "@alexkroman1/aai/host-internal";
export { FatalToolError, isFatalToolError } from "./error-policy.ts";

/**
 * Everything one tool call is given EXCEPT the toolset — the bag a subagent's
 * own tools are run with, derived by subtraction so a capability added to a
 * tool context cannot be silently missing from a delegated one.
 *
 * @internal
 */
export type ToolCallDefaults = Omit<ExecuteToolCallOptions, "toolset">;

/**
 * Run a subagent to completion (`ctx.delegate`) — implemented by
 * `createSubagentRunner` in `../subagent.ts`, which is the only caller of
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
  subagent: SpeakerDef,
  options: DelegateOptions,
  parent: ToolCallDefaults,
) => Promise<DelegateResult>;

// setImmediate rather than setTimeout(0): same yield-to-I/O semantics without
// Node's ~1ms timer clamp — saves a couple of ms on every tool call.
//
// Baselined under `guard-invariants` rule 4: a deliberate SHIPPED yield, not a
// test wait. `node:timers/promises`' `setImmediate` is not a substitute —
// `vi.useFakeTimers()` does not drive it, so a spec advancing the clock past a
// deadline returns before `pTimeout` has armed its timer (the five deadline
// specs in executor.test.ts hang with it).
const yieldTick = (): Promise<void> => new Promise((r) => setImmediate(r));

type ExecuteToolCallOptions = {
  /**
   * The {@link Toolset} that advertises the called name — the ONLY thing this
   * reads a tool from: its entry's def (schema, `onError`), its executor and
   * deadline, its `gate`, its `execute`.
   */
  toolset: Toolset;
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
  /**
   * The issuing SESSION's token meter — what a model call made from inside this
   * tool costs, and whether one may still be made (both capabilities above spend
   * on the session's bill). On the option bag rather than inside
   * `createGenerateFn` / `createSubagentRunner` (per RUNTIME, where a meter is
   * per SESSION), and because {@link ToolCallDefaults} is a subtraction, so a
   * delegated run carries it with nothing to forget. Absent for a sessionless
   * caller means uncounted, not refused — see `../usage-meter.ts`.
   */
  usage?: UsageMeter | undefined;
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
   *
   * `info.fatal` says which of the two throws this is. `false` is the case
   * above: the model got the failure and the reply carries on. `true` means the
   * tool declared the failure UNRECOVERABLE through {@link ToolDef.onError} and
   * this call is about to REJECT with a `FatalToolError` — the model is handed
   * nothing, so whoever is watching is the only one who will ever hear about
   * it. The SESSION is still alive either way, which is why neither maps to a
   * `fatal: true` error frame (that one releases the caller's microphone). A
   * reporter that ignores `info` (`../text-agent/agent.ts`'s `toolFault`) stays assignable.
   */
  onUncaught?: ((message: string, info: { readonly fatal: boolean }) => void) | undefined;
  send?: ((event: string, data: unknown) => void) | undefined;
  /**
   * This call's wait for the page — bound onto the context ONLY when the entry's
   * executor is `"client"`, for the `clientTool`'s `execute` to find (it rides
   * the context so a wrapping `execute` still runs first). Never carried into
   * `ctx.delegate`: the answer it waits for is the PARENT call's.
   */
  clientCall?: ClientToolCall | undefined;
  /**
   * `ctx.speech` — the calling session's `say`/`interrupt`. Absent (a
   * sessionless call), a context holds `DETACHED_SESSION_SPEECH`.
   */
  speech?: SessionSpeech | undefined;
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
function buildToolContext(
  options: ExecuteToolCallOptions & {
    signal: AbortSignal;
    deadlineAt: number;
    /** The client wait, present only for a `"client"` entry. */
    client: ClientToolCall | undefined;
  },
): ToolContext {
  const { env, slots, messages, sessionId, send, signal, generate, subagents, workflows, usage } =
    options;
  const ctx: ToolContext = {
    env,
    speech: options.speech ?? DETACHED_SESSION_SPEECH,
    deadlineAt: options.deadlineAt,
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
      // Checked where the request is about to be made — the turn loop's rule
      // one level up, at the other place a session spends. A rejection, not an
      // empty answer: the tool's `catch` can act on it, and an unhandled one
      // becomes a failure the model reads.
      const spent = usage?.exhausted();
      if (spent !== undefined) return Promise.reject(new Error(spent));
      // The per-call signal cancels an in-flight generation the same way it
      // unblocks the tool await. Passed unconditionally — it is always present
      // now that `ToolContext.signal` is. `onUsage` puts what it spends on this
      // session's meter.
      return generate(genOpts, { signal, onUsage: usage ? (u) => usage.record(u) : undefined });
    }) as GenerateFn,
    // The runner is handed this call's whole option bag — MINUS the tool, which
    // is the one thing a delegated run supplies itself — plus the per-call
    // signal, so cancelling the turn cancels the subagent's loop and every tool
    // call inside it. `tool` is dropped by destructuring rather than by a cast:
    // a new option is then carried into a delegated run automatically, which is
    // the property `ToolCallDefaults` exists to keep.
    // Asserted rather than inferred, for the reason the `generate` forwarder
    // above is: `DelegateFn` is OVERLOADED — a subagent declaring a `schema`
    // answers with a parsed `object` — and TypeScript cannot check an
    // overloaded signature against a single implementation. The narrowing is
    // backed by `runUntilAccepted`, which attaches `object` exactly when the
    // def carries a schema.
    delegate: ((subagent: SpeakerDef, delegateOpts: DelegateOptions): Promise<DelegateResult> => {
      if (!subagents) {
        return Promise.reject(new Error("delegate is not available in this execution context"));
      }
      const { toolset: _toolset, clientCall: _parentCall, ...defaults } = options;
      return subagents(subagent, delegateOpts, { ...defaults, signal });
    }) as DelegateFn,
    messages: messages ?? [],
    // No session → a unique per-call id, NOT "": the builtin remember/recall
    // notes are keyed by sessionId in a process-wide map, so sessionless
    // callers sharing the "" bucket would read each other's notes.
    sessionId: sessionId ?? crypto.randomUUID(),
    // The global, which is what a tool body called directly before this field
    // existed — the field buys testability, not different numbers. A spec
    // substitutes it through `createToolContext({ random })`.
    random: Math.random,
    send(event: string, data: unknown): void {
      send?.(event, data);
    },
  };
  if (options.client) bindClientToolCall(ctx, options.client);
  return ctx;
}

/**
 * Turn a throw out of `execute` into this call's answer — or into a rejection.
 *
 * The three arms {@link resolveToolError} chooses between, plus the reporting
 * each one owes. Extracted from {@link executeToolCall}'s `catch` because the
 * classification is a decision with its own argument (see `error-policy.ts`)
 * and inlining it put that function over the complexity gate — the seam is the
 * one a reader already uses: everything above is about RUNNING the tool, and
 * everything here is about what its failure means.
 *
 * @throws {FatalToolError} when the tool's `onError` declared the failure
 * unrecoverable. Nothing is returned on that path on purpose: an answered call
 * is something the model reads and reacts to, and a rejected one is not.
 */
function settleToolThrow(params: {
  name: string;
  err: unknown;
  tool: ToolDef;
  ctx: ToolContext | undefined;
  cancelled: boolean;
  logger: Logger | undefined;
  onUncaught: ExecuteToolCallOptions["onUncaught"];
}): string {
  const { name, err, tool, ctx, cancelled, logger, onUncaught } = params;
  const resolution = resolveToolError({ name, err, onError: tool.onError, ctx, cancelled });
  if (resolution.kind === "recovered") {
    // The author classified this throw as recoverable, which makes it the same
    // kind of answer a RETURNED `ToolFailure` is — so no `onUncaught`, no warn
    // line, and the result travels the path a success takes. Installing an
    // `onError` that answers is therefore also how an author silences a throw
    // they already understand.
    const text = stringifyResult(resolution.value);
    logger?.debug("Tool threw and onError answered", { tool: name, error: errorDetail(err) });
    warnOversizedResult(name, text, logger);
    return text;
  }
  if (resolution.kind === "fatal") {
    const { error } = resolution;
    // At ERROR level, not warn: the reply is losing this call outright, and the
    // only trace the model leaves behind is that it never got a result.
    if (logger) {
      logger.error("Tool execution failed fatally", {
        tool: name,
        error: errorDetail(error.cause),
      });
    } else {
      console.error(`[tool-executor] Tool execution failed fatally: ${name}`, error.cause);
    }
    onUncaught?.(error.message, { fatal: true });
    throw error;
  }
  if (logger) {
    logger.warn("Tool execution failed", { tool: name, error: errorDetail(err) });
  } else {
    console.warn(`[tool-executor] Tool execution failed: ${name}`, err);
  }
  // The message names the TOOL, which the raw error never does: what reaches
  // the model is `errorMessage(err)` alone, so a bare "Cannot read properties
  // of undefined" was the whole diagnostic an author got for a bug in a file
  // this function knows the name of.
  onUncaught?.(`Tool "${name}" threw: ${errorMessage(err)}`, { fatal: false });
  return serializeToolFailure(errorMessage(err));
}

/**
 * Validate a tool call's arguments and invoke its handler, returning the
 * stringified (and capped) result.
 *
 * @throws {FatalToolError} only when the tool's {@link ToolDef.onError} threw —
 * see this module's doc and {@link settleToolThrow}. Every caller in this
 * package lets that rejection propagate rather than converting it back into a
 * result, which is the whole point of it.
 *
 * @internal
 */
export async function executeToolCall(
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: ExecuteToolCallOptions,
): Promise<string> {
  const { toolset, logger, onUncaught } = options;
  const entry = toolset.list()[name];
  if (entry === undefined) return serializeToolFailure(`Unknown tool: ${name}`, "unknown_tool");
  const tool = entry.def;
  const schema = tool.inputSchema ?? EMPTY_PARAMS;
  // The spec allows a sync or async validate; await normalizes both.
  const parsed = await schema["~standard"].validate(args);
  if (parsed.issues) {
    return serializeToolFailure(
      `Invalid arguments for tool "${name}": ${formatSchemaIssues(parsed.issues)}`,
      "invalid_arguments",
    );
  }

  // Per-call controller, exposed to the tool as ctx.signal. It follows the
  // turn signal AND fires when the call settles exceptionally — above all on
  // timeout, which the turn signal alone never covered: pTimeout only settles
  // the await, so a timed-out tool kept running (and kept mutating shared
  // session slots) after its error result was already committed to the turn, with
  // no way to even notice it had timed out.
  const turnSignal = options.signal;
  const callController = new AbortController();
  const followTurn = (): void => callController.abort(turnSignal?.reason);
  if (turnSignal?.aborted) followTurn();
  else turnSignal?.addEventListener("abort", followTurn, { once: true });

  // Resolved BEFORE the context is built, because the context carries it:
  // `ctx.deadlineAt` is what lets a tool budget under its own deadline rather
  // than be cut off by it. Read here rather than at the `pTimeout` below, so
  // the instant a tool is told is a hair EARLIER than the one it is held to —
  // the safe direction for a budget.
  const timeoutMs = entry.timeoutMs ?? options.timeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS;
  // Set by the `fallback` below, which `pTimeout` runs on the deadline and on
  // nothing else. It is what tells the catch that THIS call timed out.
  // `pTimeout` rejects a deadline without aborting anything, so the `cancelled`
  // read below could not see one: a timeout reached `tool.onError` as though the
  // tool had faulted, and an `onError` written as "rethrow anything I do not
  // recognise" — the natural way to write one — turned a transient timeout into
  // a `FatalToolError` that killed the turn. Rule 1 in `error-policy.ts`
  // says the deadline is not a tool fault; this is what makes that true.
  //
  // A FLAG rather than an error minted up front and matched by identity: the
  // error was constructed on every call including the ones that succeed — a V8
  // stack capture per tool call, and a step runs its calls concurrently — and it
  // is only ever read on the one path that throws it. It also retires a
  // subtlety: a tool that runs its own `pTimeout` inside `execute` throws the
  // same CLASS, and that one is the tool's own failure which `onError` must
  // still see. Raised only in here, it cannot be confused with one from there.
  let timedOut = false;

  // Declared outside the try because the CATCH needs it: `tool.onError` is
  // handed the same context `execute` ran with, so a handler can read
  // `ctx.env` to tell a missing credential from a rejected one. It stays
  // `undefined` only when `buildToolContext` itself threw, which is a
  // framework bug rather than a tool one — and `resolveToolError` answers
  // "default" for it rather than calling a handler with half a context.
  let ctx: ToolContext | undefined;
  try {
    ctx = buildToolContext({
      ...options,
      signal: callController.signal,
      deadlineAt: Date.now() + timeoutMs,
      client: entry.executor === "client" ? options.clientCall : undefined,
    });
    await yieldTick();
    if (callController.signal.aborted) {
      return serializeToolFailure(`Tool "${name}" was cancelled before it ran`, "cancelled");
    }
    // The gate decides whether the body runs at all: a roster entry not on the
    // line, a dialog tool out of state. Its refusal is the model's answer.
    const refusal = toolset.gate(name, ctx);
    if (refusal !== undefined) return stringifyResult(refusal);
    // The signal makes the await settle promptly on barge-in/reset/stop; the
    // underlying execute keeps running unless it observes ctx.signal itself.
    const result = await pTimeout(Promise.resolve(toolset.execute(name, parsed.value, ctx)), {
      milliseconds: timeoutMs,
      // Runs on the deadline and never otherwise, so the throw and the flag it
      // sets are both free on every call that answers in time.
      fallback: (): never => {
        timedOut = true;
        throw new TimeoutError(`Tool "${name}" timed out after ${timeoutMs}ms`);
      },
      signal: callController.signal,
    });
    await yieldTick();
    const text = stringifyResult(result);
    // Every tool path ends here — the pipeline's AI SDK tools, the S2S
    // session's `runToolStep`, a text agent, a subagent's own tools — which is
    // what makes this the one place the provider-side size can be observed.
    warnOversizedResult(name, text, logger);
    return text;
  } catch (err: unknown) {
    // Read BEFORE the abort below, or every failure would look like one: an
    // already-aborted controller means something else cut this call — a
    // barge-in, a reset or `stop()` — and that describes the runtime rather
    // than the tool. The DEADLINE is the fourth such source and the only one
    // the controller cannot report, since `pTimeout` settles the await without
    // touching it; see `timedOut` above.
    const cancelled = callController.signal.aborted || timedOut;
    // The call is over (timeout or failure): fire the per-call signal so a
    // still-running execute can observe ctx.signal and stop its side effects.
    callController.abort(err);
    return settleToolThrow({ name, err, tool, ctx, cancelled, logger, onUncaught });
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
 * The dispatcher every in-process tool path shares: compose the toolsets
 * first-wins (the precedence `agentToolsToSchemas` advertised), look the name
 * up, or report an unknown one AS A TOOL RESULT (`reason: "unknown_tool"`) — a
 * failure the MODEL recovers from, not a throw that fails the turn. Everything
 * below the lookup stays with the caller, whose contexts genuinely differ.
 *
 * @internal
 */
export function createToolDispatcher(
  toolsets: readonly Toolset[],
  run: (toolset: Toolset, call: ToolCall) => Promise<string>,
): ExecuteTool {
  const table = composeToolsets(toolsets);
  return (name, args, sessionId, messages, options) => {
    const found = table.resolve(name);
    if (!found) {
      return Promise.resolve(serializeToolFailure(`Unknown tool: ${name}`, "unknown_tool"));
    }
    return run(found.toolset, { name, args, sessionId: sessionId ?? "", messages, options });
  };
}
