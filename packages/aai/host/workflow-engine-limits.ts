// Copyright 2026 the AAI authors. MIT license.
/**
 * The engine's own budgets: the claim lease, the wake-timer ceiling, the
 * cold-start sweep bounds, the blob TTL, and the find-limit clamp.
 *
 * Split out of `workflow-engine.ts` when it reached the 500-line cap. Every value
 * here answers "how long, or how many, before the engine gives up and lets
 * someone else try" — which is one topic, and the one an operator tunes.
 * Re-exported from `workflow-engine.ts`, so no import path changes.
 */

import { DEFAULT_WORKFLOW_FIND_LIMIT, MAX_WORKFLOW_FIND_LIMIT } from "../sdk/workflow-limits.ts";

/**
 * How long a claim is held before another executor may take the run over.
 * Long enough that an ordinary step (an LLM call, an HTTP fetch) cannot
 * outlive it, short enough that a dead sandbox's run is not stranded for long.
 */
export const WORKFLOW_LEASE_MS = 120_000;

/** Longest in-process wake timer; past this, recovery is `runDue()`'s job. */
export const MAX_WAKE_TIMER_MS = 60_000;

/** Runs one `due()` query may return, bounding a cold start's fan-out. */
export const MAX_DUE_RUNS = 20;

/**
 * Batches one `runDue()` may drain — `MAX_DUE_RUNS` × this is the ceiling on
 * runs recovered per boot.
 *
 * A BACKSTOP rather than the mechanism: the loop stops on the first short batch,
 * and every run it claims leaves `due()`'s predicate, so a healthy store drains
 * to empty well inside this. It exists so a store that misreports (a `due()` that
 * keeps returning a run nothing can claim) cannot spin the sweep forever.
 */
export const MAX_DUE_SWEEPS = 25;

/**
 * Clamp a caller's `limit` into range.
 *
 * Clamped rather than validated: `find` is reached from tool code answering "is
 * my thing ready yet?", and a caller's stray 10_000 should cost the ceiling
 * instead of failing the turn. The ceiling itself is what keeps the read under
 * `MAX_DB_RESULT_ROWS`. Shared with `recent` so the two reads cannot end up with
 * different ideas of how many rows are safe.
 */
export function clampFindLimit(requested: number | undefined): number {
  return Math.min(
    Math.max(1, Math.floor(requested ?? DEFAULT_WORKFLOW_FIND_LIMIT)),
    MAX_WORKFLOW_FIND_LIMIT,
  );
}

/**
 * How long an uploaded blob survives without a run consuming it.
 *
 * Sized against the runs, not the upload: a run that sleeps between steps can
 * legitimately take hours to reach the blob it was started with, so anything
 * shorter would delete an input out from under a live run. What it reclaims is
 * the upload nothing ever started — a closed tab, a failed `start()` — which is
 * referenced by nothing and would otherwise sit in the app's schema forever.
 */
export const WORKFLOW_BLOB_TTL_MS = 24 * 60 * 60 * 1000;
