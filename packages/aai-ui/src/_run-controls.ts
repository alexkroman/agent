// Copyright 2026 the AAI authors. MIT license.
/**
 * The two things a page does TO a run it started, bound to the run it has.
 *
 * `useWorkflowSubmit` and `useWorkflowStream` both hold a run id and neither
 * handed it back, so a page that wanted "send it now" or "stop" had to hold an
 * `api` of its own purely to write `api.wake(runId)` — which is the whole reason
 * the two raw-primitive template pages keep a client at module scope. That is a
 * page carrying the transport to make up for a hook withholding its own state.
 *
 * Both calls answer rather than fail when there is nothing to act on — `0`
 * sleeps ended, `false` this call did not end it — which is the SDK's own
 * contract for them (two tabs pressing Stop is ordinary), and it is what lets
 * the no-run case be the same answer rather than a special one a caller has to
 * branch on.
 */

import { useCallback } from "react";
import type { WorkflowApi } from "./workflow-client.ts";

/** What {@link useRunControls} returns — see {@link WorkflowSubmission}. */
export type RunControls = {
  /** End the run's `sleep()` early; resolves how many sleeps it interrupted. */
  wake: () => Promise<number>;
  /** Stop the run; resolves whether this call is what ended it. */
  cancel: () => Promise<boolean>;
};

/**
 * Bind `wake` and `cancel` to whatever run the hook is currently following.
 *
 * @param runId - The live run, or `undefined` before one exists.
 * @param getClient - The stable getter from `useWorkflowApiRef`.
 * @returns Two callbacks, stable while `runId` is.
 *
 * @internal
 */
export function useRunControls(
  runId: string | undefined,
  getClient: () => WorkflowApi,
): RunControls {
  const wake = useCallback(async () => {
    // No run is "nothing was sleeping", which is what 0 already means.
    if (runId === undefined) return 0;
    return await getClient().wake(runId);
  }, [runId, getClient]);

  const cancel = useCallback(async () => {
    if (runId === undefined) return false;
    return await getClient().cancel(runId);
  }, [runId, getClient]);

  return { wake, cancel };
}
