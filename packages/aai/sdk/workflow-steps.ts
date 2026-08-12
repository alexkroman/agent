// Copyright 2026 the AAI authors. MIT license.
/**
 * {@link StepOptions} — the per-step retry overrides.
 *
 * Its own module so `workflow-context.ts` can import it without importing
 * `workflow.ts`, which re-exports the context back. Re-exported from
 * `workflow.ts`, so no import path changes.
 *
 * It deliberately re-exports NOTHING else. `findUnjournalable`/`Journalable` sat
 * here too for a while, on the reasoning that `ctx.step` is where an author meets
 * them — but `workflow.ts` already re-exports both straight from
 * `journalable.ts`, so this copy was a second path to one symbol that no importer
 * ever took, which is what `pnpm check:knip` reports.
 */

/** Per-step overrides for {@link WorkflowContext.step}. */
export type StepOptions = {
  /**
   * Attempts before the step gives up and fails the run. Defaults to
   * {@link DEFAULT_STEP_MAX_ATTEMPTS}.
   */
  maxAttempts?: number;
  /**
   * Base backoff between attempts, doubled each time. Defaults to
   * {@link DEFAULT_STEP_BACKOFF_MS}.
   */
  backoffMs?: number;
};
