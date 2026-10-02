// Copyright 2026 the AAI authors. MIT license.
/**
 * The state a form submission carries, for both hooks that make one: the
 * form's statechart (`_workflow-form-state.ts`) bridged into React with
 * `useSyncExternalStore`, the way `use-tap-to-talk.ts` bridges its own.
 *
 * `useWorkflowSubmit` and `useWorkflowStream` stay separate hooks — they differ
 * in WHEN the run is created relative to the bytes, which is the whole reason
 * the streaming one exists — but everything around that ordering is shared:
 * the run id, the submission's own failure, the bar, `startedHere`, the
 * supersede rule, `reset` and the pause pair. Each hook still owns its own
 * submission BODY, handed to {@link SubmissionActions.submit}.
 *
 * Nothing here decides anything. The decisions are positions of the machine,
 * which is why this module holds no token, no ref to a live submission, and no
 * "is this still the current one?" check.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { findRecoveredRun, type RecoverRunOptions } from "./_recover-run.ts";
import {
  createWorkflowForm,
  type SubmissionWork,
  type WorkflowFormStore,
  type WorkflowFormView,
} from "./_workflow-form-state.ts";
import type { UploadGate } from "./upload/index.ts";

/**
 * The stable half: everything a hook's `submit` and its returned controls call.
 *
 * Split from the view deliberately. A `submit` is a `useCallback` and this is
 * one of its dependencies, so a bag that changed identity whenever `upload`
 * changed would rebuild `submit` — and with it the `onSubmit` handed to
 * `<Form>` — on every progress report. Every member reaches the machine
 * through a ref, so the bag is stable for the component's life.
 */
export type SubmissionActions = {
  /**
   * Run `work` as THE submission, superseding whatever was in flight.
   *
   * `gate` is the submission's pause, which `pauseUpload` reaches and leaving
   * the submission cancels. Resolves when the submission is over — finished,
   * failed, or abandoned by a later `submit` or a `reset` — and never rejects:
   * a failure is reported through `startError`, the way a form expects.
   */
  submit: (gate: UploadGate, work: SubmissionWork) => Promise<void>;
  /** Put the form back: abandon the bytes and drop the result. */
  reset: () => void;
  /** Park the bytes and say so on the bar. */
  pauseUpload: () => void;
  /** Send the rest. */
  resumeUpload: () => void;
};

/** What {@link useSubmissionState} hands back: the machine's view, and the actions. */
export type SubmissionState = WorkflowFormView & { actions: SubmissionActions };

const IDLE_VIEW: WorkflowFormView = {
  runId: undefined,
  startError: undefined,
  upload: undefined,
  startedHere: false,
  busy: false,
};
/**
 * The frames before the machine exists, for a page that will look its run up.
 * Busy from the FIRST render rather than from the effect, so there is no frame
 * in which a page about to adopt a run reads as idle.
 */
const RECOVERING_VIEW: WorkflowFormView = { ...IDLE_VIEW, busy: true };
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;
const idleView = (): WorkflowFormView => IDLE_VIEW;
const recoveringView = (): WorkflowFormView => RECOVERING_VIEW;

/** What a lookup is FOR, so a re-render asking the same question asks nothing. */
function questionOf(recover: RecoverRunOptions | undefined): string | undefined {
  return recover?.enabled ? `${recover.workflow}\n${recover.key}` : undefined;
}

/**
 * The shared submission scaffold. See the module doc.
 *
 * @param recover - The mount-time lookup (`_recover-run.ts`), or nothing for a
 *   hook that refuses it (`useWorkflowStream`).
 */
export function useSubmissionState(recover?: RecoverRunOptions): SubmissionState {
  // Read per lookup, so a re-render with a new client needs no new machine.
  const lookup = useRef(recover);
  lookup.current = recover;
  // What the live machine has been asked; a changed KEY is a different run and
  // is meant to re-ask, and nothing else may — see `_recover-run.ts` on reset.
  const asked = useRef<string | undefined>(undefined);
  // For the actions, which have to be stable from the first render.
  const live = useRef<WorkflowFormStore | null>(null);

  // Created in an effect (and stopped in its cleanup) so a StrictMode double
  // mount gets a fresh machine rather than a stopped one. Stopping is also
  // what abandons a submission still in flight at unmount.
  const [store, setStore] = useState<WorkflowFormStore | null>(null);
  useEffect(() => {
    const next = createWorkflowForm({
      find: async () => {
        const at = lookup.current;
        if (!at) return;
        return await findRecoveredRun(at.getClient(), at.workflow, at.key);
      },
    });
    // Asked before the first render that can see this machine, for the same
    // reason `RECOVERING_VIEW` exists.
    asked.current = questionOf(lookup.current);
    if (asked.current !== undefined) next.send({ type: "RECOVER" });
    live.current = next;
    setStore(next);
    return () => {
      next.stop();
      live.current = null;
      asked.current = undefined;
      setStore(null);
    };
  }, []);

  const question = questionOf(recover);
  useEffect(() => {
    if (!store || question === asked.current) return;
    asked.current = question;
    if (question !== undefined) store.send({ type: "RECOVER" });
  }, [store, question]);

  const beforeStore = question === undefined ? idleView : recoveringView;
  const view = useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIPTION,
    store ? store.getView : beforeStore,
  );

  const submit = useCallback((gate: UploadGate, work: SubmissionWork): Promise<void> => {
    const machine = live.current;
    // Only before the first effect or after unmount, where there is nothing to
    // submit into and nobody to show it to.
    if (!machine) return Promise.resolve();
    const done = Promise.withResolvers<void>();
    machine.send({ type: "SUBMIT", gate, work, settle: () => done.resolve() });
    return done.promise;
  }, []);
  const reset = useCallback(() => live.current?.send({ type: "RESET" }), []);
  const pauseUpload = useCallback(() => live.current?.send({ type: "PAUSE" }), []);
  const resumeUpload = useCallback(() => live.current?.send({ type: "RESUME" }), []);

  const actions = useMemo(
    () => ({ submit, reset, pauseUpload, resumeUpload }),
    [submit, reset, pauseUpload, resumeUpload],
  );

  return { ...view, actions };
}
