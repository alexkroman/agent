// Copyright 2026 the AAI authors. MIT license.
/**
 * The two buttons a page puts over a live upload, bound to whichever gate the
 * submission is currently holding.
 *
 * `useWorkflowSubmit` and `useWorkflowStream` both own an {@link UploadGate} and
 * both reported the pause the same way: park the gate, then fold `paused` into
 * the status the bar is already drawing. Folded rather than replaced, because
 * everything else about that status — which file, how far, of how many — is
 * still true. Two copies of that rule are two copies that can stop agreeing
 * about what a paused bar says.
 */

import { type Dispatch, type SetStateAction, useCallback } from "react";
import type { UploadGate } from "./_upload-session.ts";
import type { UploadStatus } from "./use-workflow-form.ts";

/** What {@link useUploadPause} returns — see {@link WorkflowSubmission}. */
export type UploadPause = {
  /** Stop the bytes in flight and hold the uploader. */
  pauseUpload: () => void;
  /** Send whatever the store is still missing. */
  resumeUpload: () => void;
};

/**
 * Bind pause/resume to the live submission's gate.
 *
 * @param getGate - Reads the gate out of the caller's ref, so the callbacks stay
 *   stable across submissions rather than being re-created per gate.
 * @param setUpload - The status setter the progress bar renders from.
 *
 * @internal
 */
export function useUploadPause(
  getGate: () => UploadGate | undefined,
  setUpload: Dispatch<SetStateAction<UploadStatus | undefined>>,
): UploadPause {
  const setPaused = useCallback(
    (paused: boolean) => {
      setUpload((current) => (current ? { ...current, paused } : current));
    },
    [setUpload],
  );

  const pauseUpload = useCallback(() => {
    getGate()?.pause();
    setPaused(true);
  }, [getGate, setPaused]);

  const resumeUpload = useCallback(() => {
    getGate()?.resume();
    setPaused(false);
  }, [getGate, setPaused]);

  return { pauseUpload, resumeUpload };
}
