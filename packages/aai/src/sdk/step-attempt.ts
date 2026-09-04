// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepInfo()` — which step a body is running as, and which ATTEMPT of it.
 *
 * The engine already knows: `attemptLoop` tracks tries locally and hands the
 * number to `withStepContext`, which is how a `stepReport()` line carries its
 * `(attempt N)` suffix. Nothing else could read it. So a step body could not
 * tell its first attempt from its last, and the two decisions that wants are
 * exactly the ones a retry policy cannot make for an author:
 *
 * - **Degrade rather than fail.** A model call that timed out twice is worth
 *   re-issuing against a cheaper, faster model on the last attempt: a shorter
 *   answer beats a failed run, and only the body knows what "cheaper" means for
 *   its own work.
 * - **Stop paying for the expensive path.** A step that fans out to three
 *   providers and reconciles them can drop to one when it is retrying, because
 *   the retry is usually the same fault again.
 *
 * ```ts
 * import { stepReport, stepInfo } from "@alexkroman1/aai/step";
 *
 * declare function summarize(text: string, model: string): Promise<string>;
 *
 * export async function summarizeChapter(text: string) {
 *   const step = stepInfo();
 *   // The last attempt buys a smaller model rather than a failed run.
 *   const model = step?.isLastAttempt === true ? "small" : "large";
 *   if (step && step.attempt > 1) await stepReport(`Retrying with ${model}.`);
 *   return await summarize(text, model);
 * }
 * ```
 *
 * ## It is the DevKit's `getStepMetadata()`, with two differences
 *
 * That function threw outside a step, which is why the DevKit-era
 * `workflow-report.ts` wrapped every call in a try/catch. This answers
 * `undefined` instead, for the reason {@link stepEnv} and `stepReport()` do: an
 * exported step is also an ordinary async function, and every workflow
 * template's tests call one directly with no run anywhere. A body that must
 * branch on it therefore tests for `undefined` and takes its non-retrying path,
 * which is the right default for a spec.
 *
 * And it carries `maxAttempts`, which the DevKit's did not. Without it
 * `isLastAttempt` is something a body computes by re-stating a number the
 * `ctx.step` call site already passed — two literals to keep in step, in two
 * files, and the failure is silent: a body that thinks attempt 3 is its last
 * when the step was given 5 degrades early on every run.
 *
 * ## Why a published slot rather than an import
 *
 * The answer lives in the host's `AsyncLocalStorage`
 * (`aai-runtime/workflow-run-context.ts`), and this module may not import it:
 * `@alexkroman1/aai/step` rides the browser bundle. So the host publishes a
 * READER — the same `Symbol.for` mechanism `stepReport()` and `stepEnv` use, and for
 * the same reason: the agent bundle carries its own copy of this module, so the
 * publisher and the reader are two module instances in one realm.
 *
 * A reader rather than the VALUE, because the value changes per step and per
 * attempt while the slot is filled once, at `createRuntimeServer`.
 *
 * @module
 */

/**
 * The registry-wide slot. Prefixed with the package name so a second copy of
 * this SDK in the same process shares it rather than shadowing it.
 */
const STEP_INFO_SLOT = Symbol.for("@alexkroman1/aai.stepInfoReader");

/**
 * Which step is running, and which attempt of it.
 *
 * @public
 */
export type StepInfo = {
  /** The step's own name, as `ctx.step` was given it. */
  readonly name: string;
  /** `name#occurrence` — the journal key, which is what makes a loop's rounds distinct. */
  readonly key: string;
  /**
   * Which try this is, 1-based.
   *
   * The WALK's count, not the journal's charge. Two overlapping deliveries of
   * one run each start at 1, because `maxAttempts` means how many times to try
   * and how many workers happen to be trying is not that number — see "An
   * attempt is a LEASE, not a tally" in `packages/aai-runtime/CLAUDE.md`.
   */
  readonly attempt: number;
  /** The ceiling this step was given — `StepOptions.maxAttempts`, or its default. */
  readonly maxAttempts: number;
  /**
   * Is this the last try, so that a throw fails the step for good?
   *
   * Provided rather than left as `attempt === maxAttempts` because the
   * subtraction is where the mistake is: a body that hard-codes the ceiling
   * degrades early on every run when the call site's `maxAttempts` changes, and
   * nothing reports it.
   *
   * A `FatalError` still ends the step wherever it is thrown, so this being
   * `false` is not a promise that another attempt will happen.
   */
  readonly isLastAttempt: boolean;
};

/**
 * What a published reader answers. `undefined` means "not inside a step".
 *
 * @internal
 */
export type StepInfoReader = () => StepInfo | undefined;

/** The shape stored in the slot. `undefined` means nothing has published. */
type StepInfoSlot = { [STEP_INFO_SLOT]?: StepInfoReader };

/**
 * Publish the reader for this process's steps.
 *
 * Called by whatever is about to serve workflows — `createRuntimeServer`, the one front
 * door `aai dev`, a self-hosted server and every deployed guest share.
 * Publishing again REPLACES, which is what a dev-server restart means; pass
 * `undefined` to unpublish, which is what a spec does when it is done with a
 * fake.
 *
 * @internal — a host concern, exported from `@alexkroman1/aai-runtime`. A step
 * author calls {@link stepInfo}.
 */
export function publishStepInfoReader(reader: StepInfoReader | undefined): void {
  if (reader === undefined) delete (globalThis as StepInfoSlot)[STEP_INFO_SLOT];
  else (globalThis as StepInfoSlot)[STEP_INFO_SLOT] = reader;
}

/**
 * Which step this code is running inside, or `undefined` when it is not in one.
 *
 * `undefined` is ORDINARY and is not an error: a workflow BODY is not a step, a
 * tool is not a step, and a spec calling an exported step directly has no run at
 * all. A body that branches on the attempt should read the `undefined` case as
 * "not retrying", which is what a spec wants and what a first attempt would have
 * said anyway.
 *
 * **Read it once, at the top.** The value is a snapshot of the attempt in
 * flight, so calling it again after an `await` inside the same step answers the
 * same thing — but a helper that reads it per call is asking a question whose
 * answer cannot change and reads as though it could.
 *
 * @public
 */
export function stepInfo(): StepInfo | undefined {
  return (globalThis as StepInfoSlot)[STEP_INFO_SLOT]?.();
}
