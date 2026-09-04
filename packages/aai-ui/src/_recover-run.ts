// Copyright 2026 the AAI authors. MIT license.
/**
 * Finding a run again when the page has lost its id.
 *
 * A run is durable and a page is not — which `useWorkflowRun`'s doc says, and
 * which was only half true of the hooks above it: the run id lived in plain
 * `useState`, so a refresh (or a same-tab navigation, or a crashed tab) left a
 * live run with nothing anywhere able to name it. The run really did continue;
 * the person really could not get back to it.
 *
 * `StartOptions.key` is the handle that survives that, and it always was — a
 * caller's own name for a run, indexed by the agent, read back with
 * `find(workflow, key)`. What was missing is the two lines that ASK. This is
 * them, plus the four decisions they turn out to carry.
 *
 * ## It is a MOUNT-time act, not "whenever there is no run"
 *
 * The tempting spelling is "if we hold no run id, look one up", and it breaks
 * `reset()`: a form put back to its initial state holds no run id, so the next
 * pass would re-adopt the very run the person had just dismissed — a Clear
 * button that clears nothing. So the lookup runs once per mount (and again only
 * if the KEY changes, which is a different person's run), and every later
 * absence of a run id is taken at face value.
 *
 * ## The lookup NEVER wins a race against a submit
 *
 * A person who reloads and immediately submits has started the run they want,
 * and an answer that was already in flight names an older one. The caller
 * therefore adopts through `current ?? found`: the recovered id fills an empty
 * slot and never replaces a full one.
 *
 * ## A failed lookup is REPORTED
 *
 * The alternative is a page that quietly shows an empty form to somebody whose
 * run is live, who then starts a second one — the duplicated work the key
 * exists to prevent, and on a workflow app that is real money. A person who has
 * never run anything pays a banner they can ignore. Same trade as
 * `useWorkflows`, for the same reason: an empty answer here is a confident
 * false statement.
 *
 * ## It is ON by default, and it used to be opt-in
 *
 * The argument for opt-in was that a `key` on its own means only "record this
 * with the run" — which is what a voice agent's `ctx.workflows.start({ key })`
 * means, there being no page to put a run back on. A FORM is the other case: it
 * is the page, and losing the run is the thing it cannot recover from. Six of
 * six page templates wrote `useRunKey()` and `recover: true` together, which is
 * the same shape `session-resume-store.ts` names on the voice side — a default
 * in the wrong place — so `useWorkflowSubmit` now mints the key and asks.
 *
 * `enabled` remains, because `recover: false` remains: a page whose form must
 * always open empty says so, and then nothing here runs.
 */

import { errorMessage } from "@alexkroman1/aai";
import { useEffect, useRef, useState } from "react";
import type { WorkflowApi } from "./workflow-client.ts";

/** What {@link useRecoveredRun} needs. */
export type RecoverRunOptions = {
  /** The workflow whose runs are indexed under `key`. */
  workflow: string;
  /** The caller's handle on its own run. `useDefaultRunKey` always supplies one. */
  key: string;
  /** Whether the caller asked for this at all — `recover` at the call site. */
  enabled: boolean;
  /** The stable getter from `useWorkflowApiRef`. */
  getClient: () => WorkflowApi;
  /** Adopt this run. Called at most once, and never with an empty answer. */
  onFound: (runId: string) => void;
  /** The lookup failed, and the page has to say so. */
  onError: (message: string) => void;
};

/**
 * Look up the newest run for a key, once, as the component mounts.
 *
 * @param opts - See {@link RecoverRunOptions}.
 * @returns Whether the lookup is still out. A caller folds it into its own
 *   `pending`, because a form offering Submit while a live run is arriving is a
 *   form inviting a second one.
 *
 * @internal
 */
export function useRecoveredRun(opts: RecoverRunOptions): boolean {
  const { workflow, key, enabled, getClient } = opts;
  // True from the FIRST render rather than from the effect, so there is no
  // frame in which a page about to adopt a run reads as idle.
  const [recovering, setRecovering] = useState(enabled);
  // The two callbacks through a ref, for the reason `_workflow-api-ref.ts`
  // holds the client in one: a call site writes them inline, so as dependencies
  // they would restart the lookup on every render it causes.
  const handlers = useRef(opts);
  handlers.current = opts;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setRecovering(true);
    getClient()
      // The newest is the only one a form can show; the rest are what
      // `useWorkflowRuns` is for.
      .find(workflow, key, { limit: 1 })
      .then((found) => {
        if (cancelled) return;
        const newest = found[0];
        if (newest !== undefined) handlers.current.onFound(newest.runId);
        setRecovering(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        handlers.current.onError(errorMessage(err));
        setRecovering(false);
      });
    return () => {
      cancelled = true;
    };
    // `getClient` is stable for the component's life; a changed KEY is a
    // different run and is meant to re-ask. Nothing else may re-arm this — see
    // the module doc on `reset()`.
  }, [enabled, key, workflow, getClient]);

  return recovering;
}
