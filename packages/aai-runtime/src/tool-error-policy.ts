// Copyright 2026 the AAI authors. MIT license.
/**
 * What a tool's exception BECOMES — the one place the three kinds of tool
 * failure are told apart.
 *
 * A tool can fail in three ways and, until {@link ToolDef.onError} existed, the
 * runtime could see only one of them:
 *
 * - **Expected** — `execute` RETURNS a {@link ToolFailure}. The author is saying
 *   "the model can recover from this", and it goes back as an ordinary result.
 *   That path never reaches this module.
 * - **Unexpected but recoverable** — `execute` THROWS and the author has
 *   classified the throw with `onError`, returning what the model should see.
 * - **Unrecoverable** — `execute` throws and `onError` throws in turn. The call
 *   REJECTS: the model is handed nothing, so it cannot spend the reply's
 *   `maxSteps` budget retrying a tool that cannot work.
 *
 * **A tool with no `onError` keeps the old behaviour exactly**, which is why
 * {@link resolveToolError} answers `"default"` rather than synthesizing a
 * recoverable outcome for it: every tool written before this field existed
 * depends on the throw arriving as a result, and the default is still the right
 * answer for a flaky upstream.
 *
 * Split out of `tool-executor.ts` rather than added to it: that file is the
 * CALL (validate, build the context, time it out, size the result) and this is
 * a policy over one of its outcomes, with three paragraphs of argument per
 * branch. Keeping them together put the executor within a few lines of the
 * 500-line cap for no reader's benefit.
 */

import type { ToolContext, ToolErrorHandler, ToolFailure } from "@alexkroman1/aai";
import { errorMessage } from "@alexkroman1/aai/utils";

/**
 * A tool failure the author declared UNRECOVERABLE, by throwing from
 * {@link ToolDef.onError}.
 *
 * It carries the original throw as `cause`, so a log or a test can still reach
 * the `TypeError` (or the missing-credential error) the author decided about —
 * the wrapper adds the name of the tool, which the raw error never has.
 *
 * `executeToolCall` rejects with this instead of answering, which is the whole
 * difference: an answered call is something the model reads and reacts to, and
 * a rejected one is not.
 *
 * @internal
 */
export class FatalToolError extends Error {
  /** The tool the model called, as the model named it. */
  readonly toolName: string;
  constructor(toolName: string, cause: unknown) {
    super(`Tool "${toolName}" failed fatally: ${errorMessage(cause)}`, { cause });
    this.name = "FatalToolError";
    this.toolName = toolName;
  }
}

/**
 * Whether a rejection came out of a tool call the author declared fatal.
 *
 * `instanceof` is enough here and deliberately: every producer and every
 * consumer is inside this package, and a tool body runs in the same realm as
 * the executor that called it (the guest harness bundles both).
 *
 * @internal
 */
export function isFatalToolError(err: unknown): err is FatalToolError {
  return err instanceof FatalToolError;
}

/**
 * What the executor should do with a throw.
 *
 * `"default"` is a distinct arm rather than a pre-built recoverable outcome so
 * the no-`onError` path stays byte-identical to what it was — including which
 * log level it uses and the fact that `onUncaught` fires for it.
 *
 * @internal
 */
export type ToolErrorResolution =
  /** No handler (or nothing for a handler to classify): report and serialize as before. */
  | { readonly kind: "default" }
  /** The handler answered; `value` goes to the model as this call's result. */
  | { readonly kind: "recovered"; readonly value: ToolFailure | string }
  /** The handler threw: the call rejects and the model is handed nothing. */
  | { readonly kind: "fatal"; readonly error: FatalToolError };

/** A value that would be awaited if anything awaited it — see {@link resolveToolError}. */
function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/**
 * Ask the tool's `onError` what a throw means.
 *
 * Four rules, each of which exists to keep a mistake from reading as a feature:
 *
 * - **A CANCELLED call is not a tool fault.** When the call was already aborted
 *   — a barge-in, a reset, `stop()`, or the per-call deadline — the rejection
 *   describes the runtime, not the tool, and `onError` is not consulted at all.
 *   Otherwise every handler would have to filter aborts before it could
 *   classify anything, and a handler that forgot would turn an ordinary
 *   interruption into a fatal failure.
 * - **`undefined` means "not handled".** A handler written to log and nothing
 *   else returns nothing, and stringifying that would hand the model the string
 *   `null` as the tool's answer. It falls through to the default instead.
 * - **A thenable is refused, fatally.** The handler is synchronous by contract
 *   (there is no budget left to await in — the deadline may already have
 *   passed), so an `async` handler's promise would be serialized as `{}` and
 *   the model would read an empty object as the result. The same rule
 *   `slot.updateTool` applies to a mutator body, and it fails loudly for the
 *   same reason.
 * - **A handler that throws for its OWN reason is fatal too.** A `TypeError`
 *   inside `onError` is not a classification, and there is nothing left to ask;
 *   treating it as recoverable would send the model a message about the
 *   handler rather than about the tool.
 *
 * @internal
 */
export function resolveToolError(params: {
  readonly name: string;
  readonly err: unknown;
  readonly onError: ToolErrorHandler | undefined;
  /** Absent only if the context could not be built, which is a framework bug, not a tool one. */
  readonly ctx: ToolContext | undefined;
  /** True when the call had already been aborted when the throw arrived. */
  readonly cancelled: boolean;
}): ToolErrorResolution {
  const { name, err, onError, ctx, cancelled } = params;
  if (cancelled || onError === undefined || ctx === undefined) return { kind: "default" };
  let handled: unknown;
  try {
    handled = onError(err, ctx);
  } catch (handlerErr: unknown) {
    return { kind: "fatal", error: new FatalToolError(name, handlerErr) };
  }
  if (handled === undefined) return { kind: "default" };
  if (isThenable(handled)) {
    return {
      kind: "fatal",
      error: new FatalToolError(
        name,
        new TypeError(
          `onError for tool "${name}" returned a promise. It is synchronous by contract — ` +
            "do the awaiting inside execute, where the call's deadline still applies.",
        ),
      ),
    };
  }
  return { kind: "recovered", value: handled as ToolFailure | string };
}

/**
 * The affordance that makes a FATAL tool error actually stop the turn.
 *
 * {@link FatalToolError} rejects the tool call, and on its own that is not
 * enough: the AI SDK catches a rejecting `execute`, emits a `tool-error` stream
 * part and keeps stepping. `pipeline-stream-parts.ts` drops that part on its
 * `default:` arm, so the model was handed *something* it could retry against
 * while the author had declared the failure unrecoverable — the exact outcome
 * `onError`'s fatal arm exists to prevent, one layer up.
 *
 * A latch rather than a plain `AbortController` for three reasons, each of
 * which was a wrong first design:
 *
 * - **It has to be RESETTABLE.** A pipeline transport builds its tool set once
 *   per session and runs many turns through it, so a controller minted beside
 *   the tools would abort every later turn too. `reset()` mints a fresh
 *   controller and each turn reads {@link FatalToolLatch.signal} at
 *   request-assembly time.
 * - **The turn's own signal must NOT be the one that fires.** Aborting that
 *   would make the turn indistinguishable from a barge-in: the pipeline would
 *   persist an `[interrupted]` tail, skip the TTS drain and speak nothing. The
 *   latch's signal is combined into the LLM request's signal alone, so the
 *   stream stops while the turn stays alive and ends through its ordinary
 *   failure path — which is the path that speaks `errorPhrase`.
 * - **The error is kept**, not just the fact of it. The turn reports which tool
 *   killed it, and a reader that only saw an `AbortError` could not say.
 *
 * @internal
 */
export interface FatalToolLatch {
  /** Start a fresh turn: a new signal, no error. Call before assembling a request. */
  reset(): void;
  /** This turn's signal — aborted the moment a fatal tool error is reported. */
  signal(): AbortSignal;
  /** A tool declared its failure unrecoverable. Idempotent within a turn. */
  report(error: FatalToolError): void;
  /** The error that stopped this turn, or `undefined` if none did. */
  error(): FatalToolError | undefined;
}

/**
 * One latch per session (pipeline) or per run (text mode).
 *
 * Turns are serialized — the pipeline's turn chain guarantees it — so one latch
 * per session is safe, and `reset()` at the top of a turn is what makes it so.
 * A latch that was never reset simply has an un-aborted signal and no error,
 * which is the correct reading of "no fatal tool error has happened".
 *
 * @internal
 */
export function createFatalToolLatch(): FatalToolLatch {
  let controller = new AbortController();
  let fatal: FatalToolError | undefined;
  return {
    reset(): void {
      controller = new AbortController();
      fatal = undefined;
    },
    signal: () => controller.signal,
    report(error: FatalToolError): void {
      // FIRST report wins. A step runs its tool calls concurrently, so two can
      // fail fatally in one step; the turn is over either way, and the one that
      // stopped it is the one that got there first.
      if (fatal !== undefined) return;
      fatal = error;
      controller.abort(error);
    },
    error: () => fatal,
  };
}

/**
 * The signal a model REQUEST runs under: the caller's, plus a fatal-tool latch.
 *
 * The two are deliberately not one signal, and that is the whole reason this
 * mechanism works. Aborting the TURN's signal would make a fatal tool error
 * indistinguishable from a barge-in — the pipeline would persist an
 * `[interrupted]` tail, skip the TTS drain and speak nothing — where what it
 * should produce is a FAILED turn: the caller hears `errorPhrase` and the
 * session lives.
 *
 * `AbortSignal.any` holds its sources weakly, so a settled turn leaves no
 * listener behind on either. An absent caller signal (text mode's optional
 * `turn.signal`) yields the latch's alone.
 *
 * @internal
 */
export function withFatalSignal(signal: AbortSignal, fatalTool?: FatalToolLatch): AbortSignal;
/** The text agent's `turn.signal` is optional, so the answer can be too. @internal */
export function withFatalSignal(
  signal: AbortSignal | undefined,
  fatalTool: FatalToolLatch | undefined,
): AbortSignal | undefined;
export function withFatalSignal(
  signal: AbortSignal | undefined,
  fatalTool: FatalToolLatch | undefined,
): AbortSignal | undefined {
  const fatalSignal = fatalTool?.signal();
  if (fatalSignal === undefined) return signal;
  return signal === undefined ? fatalSignal : AbortSignal.any([signal, fatalSignal]);
}
