// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow authoring surface's numeric limits, and the one sentence every
 * unavailable-engine path answers with.
 *
 * Split out of `workflow.ts` when it reached the 500-line cap. They belong
 * together because three of the four are the SAME constraint seen from different
 * call sites: replay reads the journal back through `ctx.db`, which throws past
 * `MAX_DB_RESULT_ROWS`, so both the step cap and the find ceiling are sized under
 * it. Re-exported from `workflow.ts`, so no import path changes.
 */

/**
 * Default attempts for one {@link WorkflowContext.step} before the run fails.
 *
 * Three rather than one because the failures a step sees are overwhelmingly
 * transient (a provider 503, a pooler hiccup), and rather than unbounded
 * because a step that fails deterministically should surface as a failed run
 * an author can read, not as a retry loop that bills forever.
 */
export const DEFAULT_STEP_MAX_ATTEMPTS = 3;

/** Base delay for the exponential backoff between step attempts (ms). */
export const DEFAULT_STEP_BACKOFF_MS = 500;

/**
 * Steps one run may journal before it is failed deliberately.
 *
 * A hard cap rather than a soft one, because the failure it prevents is
 * silent: replay reads the journal back through `ctx.db`, which throws past
 * {@link MAX_DB_RESULT_ROWS} rows, and a journal that could not be read in
 * full would look like a run with no history — i.e. every completed step
 * would run a second time. A workflow that needs more iterations than this
 * should fan out into child runs rather than one long journal.
 */
export const MAX_WORKFLOW_STEPS = 500;

/** Runs {@link WorkflowClient.find} returns when the caller names no limit. */
export const DEFAULT_WORKFLOW_FIND_LIMIT = 10;

/**
 * Ceiling on {@link WorkflowClient.find}'s limit.
 *
 * The same reasoning as {@link MAX_WORKFLOW_STEPS}: the read goes through
 * `ctx.db`, which throws past `MAX_DB_RESULT_ROWS`, and a `find` that threw
 * would take out the tool call asking "is my thing ready yet?" rather than
 * answering it.
 */
export const MAX_WORKFLOW_FIND_LIMIT = 100;

/**
 * Error text a `ctx.workflows` call rejects with when the app has no engine —
 * no workflows declared, or storage disabled so the journal has nowhere to
 * live. One string so `aai dev` and the platform read identically, exactly
 * like {@link STORAGE_DISABLED_MESSAGE}.
 */
export const WORKFLOWS_UNAVAILABLE_MESSAGE =
  "No workflow engine is available for this app. Declare workflows with " +
  "`agent({ workflows })`, and enable storage with `aai storage enable` (or set " +
  "DATABASE_URL in the project .env under `aai dev`) — the run journal requires it.";

/**
 * Continuations one chain may make (`ctx.continueAs`).
 *
 * A RUNAWAY GUARD, not a design limit. An unconditional `continueAs` is an
 * infinite chain of runs that bills forever, and it is easy to write — the first
 * draft of this feature's own test did exactly that and hung the suite. Past this
 * the chain fails with a message naming the cause, which is a bug report rather
 * than a cost.
 *
 * Sized so it cannot be reached by accident by a real workload: 500 journal
 * entries per run times this is a quarter of a million steps, which is far past
 * anything a single logical job should be expressed as.
 */
export const MAX_CONTINUATIONS = 500;
