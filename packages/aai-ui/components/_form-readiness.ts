// Copyright 2026 the AAI authors. MIT license.
/**
 * Whether a form's own fields exist yet.
 *
 * `<Form>` leans entirely on NATIVE validation — it is a real `<form>` with no
 * `noValidate`, so a `required` field is what stops an empty submit, and the
 * module doc next door says so. That has one hole, and it is the whole reason
 * this exists: a field set declared REMOTELY is not in the DOM while its
 * declaration is in flight, so there is nothing for the browser to validate and
 * an empty submit sails through.
 *
 * It is not theoretical. `<WorkflowFields>` renders `null` until the workflow
 * listing lands, so the transcription desk's first click — before the one-request
 * lookup answered — submitted a form holding only its button. The browser was
 * happy, the payload was `{}`, and the run was refused by the agent with
 * `Invalid input for workflow "transcribeStream": recording: Invalid input`: a
 * schema complaint about a field the person had not been shown, naming a workflow
 * they did not choose by name, for a file picker that appeared a moment later.
 *
 * ## Readiness is DECLARED by the children, because only they know
 *
 * `Form` cannot ask. It renders `{children}` and reads the DOM on submit, and a
 * pending fetch leaves no trace in the DOM at all — which is exactly the
 * difference from `data-aai-read`, the other thing a child tells the form: that
 * one describes an element that EXISTS. So this is a context rather than an
 * attribute, and it carries the one fact a DOM read cannot recover.
 *
 * A form with no such children is ready by definition — `useFormFieldsPending`
 * outside a provider reports nothing pending, so every hand-written form is
 * unaffected and `Form` keeps working outside this package.
 */

import { createContext, useCallback, useContext, useEffect, useId, useState } from "react";

/** What a child calls to say whether its own fields are ready. */
type Readiness = (key: string, pending: boolean) => void;

/**
 * Set by `Form`, read by any field set that fetches its own declaration.
 *
 * `undefined` means no `Form` above, which is legal: the fields render, they are
 * simply not gating anything.
 */
const FormReadinessContext = createContext<Readiness | undefined>(undefined);

export const FormReadinessProvider = FormReadinessContext.Provider;

/**
 * Track which children are still waiting for their fields.
 *
 * A SET keyed by the child's own `useId`, not a counter: a child that re-renders
 * while pending must not increment twice, and one that unmounts mid-flight must
 * not leave the form disabled forever. Both are the ordinary lifecycle here — a
 * page that switches workflows swaps one `<WorkflowFields>` for another.
 */
export function useFormReadiness(): { pending: boolean; declare: Readiness } {
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set());
  const declare = useCallback<Readiness>((key, pending) => {
    setWaiting((held) => {
      if (pending === held.has(key)) return held;
      const next = new Set(held);
      if (pending) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  return { pending: waiting.size > 0, declare };
}

/**
 * Declare from a child that its fields are, or are no longer, still loading.
 *
 * Reports through an EFFECT rather than during render, because this writes to a
 * parent's state — doing it in the render body is the "cannot update a component
 * while rendering a different component" warning, and under StrictMode it is a
 * double report the parent has to be idempotent about anyway. The cleanup
 * releases the claim, so an unmounted field set never holds the form shut.
 */
export function useDeclareFieldsPending(pending: boolean): void {
  const declare = useContext(FormReadinessContext);
  const key = useId();
  useEffect(() => {
    if (!declare) return;
    declare(key, pending);
    return () => declare(key, false);
  }, [declare, key, pending]);
}
