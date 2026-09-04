// Copyright 2026 the AAI authors. MIT license.
/**
 * The state a form submission carries, for both hooks that make one.
 *
 * `useWorkflowSubmit` and `useWorkflowStream` stay separate hooks — they differ
 * in WHEN the run is created relative to the bytes, which is the whole reason
 * the streaming one exists — but everything around that ordering was written
 * twice: the same four `useState`s, the same ref holding the live submission,
 * the same prologue, the same superseded-submission guard, the same `reset`,
 * and the same pause pair. Roughly forty-five lines and thirty of comment.
 *
 * The copy had already diverged in ways nobody chose, which is the argument for
 * this module rather than for tidiness. What is here is only the scaffold; each
 * hook still owns its own `submit` body.
 *
 * ## The superseded-submission rule
 *
 * A submission that has been replaced owns none of this state any more. Its
 * walk unwinds AFTER the next one has already set `starting`, so clearing
 * unconditionally in a `finally` would report the live submission as finished
 * and drop the bar it is drawing. {@link SubmissionState.end} is that check,
 * made once here instead of at each hook's own `finally`.
 */

import type { Dispatch, SetStateAction } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useUploadPause } from "./_upload-pause.ts";
import type { UploadGate } from "./_upload-session.ts";
import type { UploadStatus } from "./use-workflow-form.ts";

/**
 * What a hook installs as its live submission.
 *
 * Generic over the token because the two hooks hold different things —
 * `useWorkflowSubmit` an `UploadSession` (the walk needs its id maps),
 * `useWorkflowStream` a bare gate in a wrapper — and all this module needs from
 * either is the gate, which is what a supersede and a `reset` cancel.
 */
export type SubmissionToken = { gate: UploadGate };

/**
 * The stable half: everything a `submit` body calls.
 *
 * Split from the values deliberately. A `submit` is a `useCallback` and this is
 * one of its dependencies, so a bag that changed identity whenever `upload`
 * changed would rebuild `submit` — and with it the `onSubmit` handed to
 * `<Form>` — on every progress report. Every member here is a `useState`
 * setter or a `useCallback` with no changing dependency, so the bag is stable
 * for the component's life.
 */
export type SubmissionActions<S extends SubmissionToken> = {
  /**
   * The full dispatch, not a plain setter: `useWorkflowSubmit`'s recovery
   * lookup writes `(current) => current ?? found`, so that a run the person has
   * already started this session is never displaced by one read back from the
   * key index.
   */
  setRunId: Dispatch<SetStateAction<string | undefined>>;
  setStartError: Dispatch<SetStateAction<string | undefined>>;
  setUpload: Dispatch<SetStateAction<UploadStatus | undefined>>;
  /**
   * Open a submission: supersede whatever was in flight and install `token`.
   *
   * Cancels the previous gate first, so a stale submission cannot park the new
   * one, and clears the previous run id BEFORE the request rather than when it
   * returns — a finished result sitting under a form that is already submitting
   * again is the one wrong answer this can give, and it looks like a right one.
   */
  begin: (token: S) => void;
  /**
   * Close `token`, if it is still the live one. See "The superseded-submission
   * rule" above.
   */
  end: (token: S) => void;
  /** Put the form back: abandon the bytes and drop the result. */
  reset: () => void;
  /** Park the bytes and say so on the bar. */
  pauseUpload: () => void;
  /** Send the rest. */
  resumeUpload: () => void;
};

/** What {@link useSubmissionState} hands back. */
export type SubmissionState<S extends SubmissionToken> = {
  /** The run this submission started, once it has one. */
  runId: string | undefined;
  /** Whether a submission is in flight — the POST and the bytes, not the run. */
  starting: boolean;
  /** The submission's own failure, as against the run's. */
  startError: string | undefined;
  /** The bar's state, or nothing when there is no upload to describe. */
  upload: UploadStatus | undefined;
  /** See {@link SubmissionActions} for why these are their own bag. */
  actions: SubmissionActions<S>;
};

/** The shared submission scaffold. See the module doc. */
export function useSubmissionState<S extends SubmissionToken>(): SubmissionState<S> {
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | undefined>(undefined);
  const [upload, setUpload] = useState<UploadStatus | undefined>(undefined);
  // The live submission, so `pauseUpload` reaches the gate the walk is waiting
  // on. A ref rather than state: nothing renders from it, and a re-render per
  // pause would be a re-render that changes nothing on the page.
  const current = useRef<S | undefined>(undefined);

  const begin = useCallback((token: S) => {
    setStarting(true);
    setStartError(undefined);
    setRunId(undefined);
    current.current?.gate.cancel();
    current.current = token;
  }, []);

  const end = useCallback((token: S) => {
    if (current.current !== token) return;
    current.current = undefined;
    setStarting(false);
    // Dropped whichever way it went. From here the wait belongs to the RUN,
    // which `run` and `pending` describe, and a bar left at 100% under a
    // running workflow reads as the thing that is taking the time.
    setUpload(undefined);
  }, []);

  const reset = useCallback(() => {
    // Abandoned rather than left running: a form put back to its initial state
    // has no bar to draw and no submission to finish, so bytes still going
    // would be bytes nobody is waiting for. No error is reported for it — that
    // would be the page reporting the person's own button back to them.
    current.current?.gate.cancel();
    current.current = undefined;
    setRunId(undefined);
    setStartError(undefined);
    setUpload(undefined);
  }, []);

  // The gate stops the bytes; the hook is what makes the page say so — see
  // `_upload-pause.ts`.
  const { pauseUpload, resumeUpload } = useUploadPause(
    useCallback(() => current.current?.gate, []),
    setUpload,
  );

  const actions = useMemo(
    () => ({ setRunId, setStartError, setUpload, begin, end, reset, pauseUpload, resumeUpload }),
    [begin, end, reset, pauseUpload, resumeUpload],
  );

  return { runId, starting, startError, upload, actions };
}
