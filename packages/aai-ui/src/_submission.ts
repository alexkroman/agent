// Copyright 2026 the AAI authors. MIT license.
/**
 * Everything a submit hook is, bar its BODY.
 *
 * `useWorkflowSubmit` (`use-workflow-form.ts`) and `useWorkflowStream`
 * (`use-workflow-stream.ts`) differ in one thing — when the run is created
 * relative to the bytes — and that one thing is the submission body each hands
 * to the form's statechart. Everything after the body was written out twice,
 * identically: the watch over the run id (`useWorkflowRun`), the two controls
 * bound to it (`_run-controls.ts`), `pending` as "the machine is busy or the
 * watch is still polling", the press-to-settle stopwatch
 * (`_submission-timing.ts`), a `reset` that clears both, and the fourteen-field
 * `WorkflowSubmission` assembled from all of it. Two copies of a return object
 * that have to agree field for field are two copies that can stop agreeing —
 * the stream hook's type is an ALIAS of the form hook's for the same reason —
 * so the tail is one function, and each hook keeps only what makes it itself.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { useCallback } from "react";
import type { RecoverRunOptions } from "./_recover-run.ts";
import { useRunControls } from "./_run-controls.ts";
import { useSubmissionState } from "./_submission-state.ts";
import { useSubmissionTiming } from "./_submission-timing.ts";
import type { SubmissionWork } from "./_workflow-form-state.ts";
import type { UploadGate } from "./upload/index.ts";
import { useWorkflowRun } from "./use-workflow-run.ts";
import type { WorkflowApi } from "./workflow-client.ts";
import type { WorkflowSubmission, WorkflowSubmissionScope } from "./workflow-submission.ts";

/**
 * What one `submit(input)` does, from the hook that owns it: the gate the
 * bytes pause through, and the work that runs as THE submission (see
 * `SubmissionActions.submit`). Called per press with the client read at that
 * moment, after the stopwatch has marked it.
 *
 * It is a `useCallback` dependency of `submit`, so a hook hands over a stable
 * one — rebuilt only when what it closes over changes — or `submit`, and with
 * it the `onSubmit` a page gives `<Form>`, is rebuilt every render.
 */
export type BeginSubmission = (
  input: unknown,
  client: WorkflowApi,
) => { gate: UploadGate; work: SubmissionWork };

/** What {@link useSubmission} needs from the hook. */
export type SubmissionOptions = {
  /** The stable getter from `useWorkflowApiRef` — the hook's, since the convention keys on the hook file. */
  getClient: () => WorkflowApi;
  /** The caller's client, for the watch; `undefined` is the page's own agent. */
  api: WorkflowApi | undefined;
  /** How often the fallback poll re-reads a live run; `undefined` is the default. */
  intervalMs: number | undefined;
  /** The mount-time lookup, or nothing for a hook that refuses it (`useWorkflowStream`). */
  recover?: RecoverRunOptions;
  /** Who finds the run again — reported back as `WorkflowSubmission.scope`. */
  scope: WorkflowSubmissionScope;
  /** The hook's own half — see {@link BeginSubmission}. */
  begin: BeginSubmission;
};

/**
 * The shared tail of a submit hook: the statechart, the watch, the controls,
 * the stopwatch, and the `WorkflowSubmission` built from them. See the module
 * doc.
 */
export function useSubmission(options: SubmissionOptions): WorkflowSubmission<unknown, never> {
  const { getClient, api, intervalMs, recover, scope, begin } = options;

  // The run id, the submission's failure, the bar, `startedHere`, the
  // supersede rule, `reset` and the pause pair — the form's statechart. See
  // `_submission-state.ts`; the lookup it may run on mount is `_recover-run.ts`.
  const form = useSubmissionState(recover);
  const { runId, actions } = form;

  const tracked = useWorkflowRun<unknown>(runId, omitUndefined({ api, intervalMs }));
  const { wake, cancel } = useRunControls(runId, getClient);
  // `tracked.polling` rather than a second derivation from the snapshot, and
  // that is the whole of it: `useWorkflowRun` gives up on an id the agent
  // keeps reporting as unknown (`MAX_MISSING_READS`), which leaves `run`
  // undefined — so `!isTerminal(tracked.run)` reads as "still waiting" and
  // pinned the submit button disabled and reading "Working…" for the life of
  // the page, with the correct error shown directly above it. That stop is
  // exactly what `polling` exists to report, per its own doc: it cannot be
  // derived from the snapshot. `busy` — submitting or looking the run up —
  // covers the gap between the POST returning and the first read landing,
  // and the same gap on a RELOAD, where a form that offered Submit while a
  // live run was arriving would invite a second one.
  const pending = form.busy || tracked.polling;
  const { timing, markSubmitted, clear: clearTiming } = useSubmissionTiming(pending);

  const submit = useCallback(
    (input: unknown) => {
      markSubmitted();
      const { gate, work } = begin(input, getClient());
      return actions.submit(gate, work);
    },
    [begin, getClient, actions, markSubmitted],
  );

  const reset = useCallback(() => {
    clearTiming();
    // `startedHere` is part of the state `reset()` puts back, and the machine
    // clears it on the same edge — the six templates that kept it by hand each
    // had to remember the mirror.
    actions.reset();
  }, [actions, clearTiming]);

  return {
    submit,
    submitForm: submit,
    reset,
    wake,
    cancel,
    pauseUpload: actions.pauseUpload,
    resumeUpload: actions.resumeUpload,
    run: tracked.run,
    startedHere: form.startedHere,
    pending,
    upload: form.upload,
    error: form.startError ?? tracked.error,
    timing,
    scope,
  };
}
