// Copyright 2026 the AAI authors. MIT license.
/**
 * The press-to-settle stopwatch both submit hooks report as
 * `WorkflowSubmission.timing`: the mark `submit()` was called at, and the mark
 * the submission settled at, read off the one flag that spans both waits.
 *
 * It is the half of `transcription-workflow`'s `useTotalLatency` that is a
 * fact about the SUBMISSION rather than about the page: that template kept
 * `startedAt`/`frozenMs` in its own state, armed by its own submit handler
 * and cleared by its own Clear button — shadow state for two instants only
 * the hook can place exactly. The rendering half (the interval that re-draws
 * a running clock, the "before the run / inside it" split) stays on the page,
 * because it is the page that decides how to print a duration.
 *
 * Two details it would be easy to get wrong, both kept from the template:
 *
 * - **The settle is measured in the effect that sees `pending` fall**, so the
 *   mark is the moment the run settled rather than whenever the page next
 *   drew. And only after `pending` has been seen TRUE since the press — a
 *   press that lands one render before the submission reports itself in
 *   flight would otherwise freeze the clock at zero.
 * - **`performance.now()`, not `Date.now()`.** Monotonic; see
 *   `WorkflowSubmissionTiming`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowSubmissionTiming } from "./workflow-submission.ts";

/** What the stopwatch hands a submit hook. */
export type SubmissionTiming = {
  /** The marks, for `WorkflowSubmission.timing`. A new object only when a mark changes. */
  timing: WorkflowSubmissionTiming;
  /** Call from `submit()`: sets `submittedAt`, clears `settledAt`. */
  markSubmitted: () => void;
  /** Call from `reset()`: drops both marks. */
  clear: () => void;
};

const NONE: WorkflowSubmissionTiming = {};

/**
 * The stopwatch over `pending` — see the module doc.
 *
 * @param pending - The submission's own `pending`: true from the press until
 *   the run settles, which is the whole of what the clock covers.
 */
export function useSubmissionTiming(pending: boolean): SubmissionTiming {
  const [timing, setTiming] = useState<WorkflowSubmissionTiming>(NONE);
  // Whether `pending` has been seen true since the last press — see the module doc.
  const began = useRef(false);

  useEffect(() => {
    if (timing.submittedAt === undefined || timing.settledAt !== undefined) return;
    if (pending) {
      began.current = true;
      return;
    }
    if (began.current) {
      const settledAt = performance.now();
      setTiming((at) => (at.settledAt === undefined ? { ...at, settledAt } : at));
    }
  }, [pending, timing]);

  const markSubmitted = useCallback(() => {
    began.current = false;
    setTiming({ submittedAt: performance.now() });
  }, []);

  const clear = useCallback(() => {
    began.current = false;
    setTiming(NONE);
  }, []);

  return { timing, markSubmitted, clear };
}
