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
 * them, plus the four decisions they turn out to carry. The question lives
 * here; the decisions about WHEN are positions of the form's statechart
 * (`_workflow-form-state.ts`), where this lookup is the `recovering` state's
 * invoke.
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
 * and an answer that was already in flight names an older one. A `SUBMIT` (or a
 * `RESET`) leaves `recovering`, which stops the lookup, so the late answer is
 * dropped by the machine rather than reconciled against the run that replaced
 * it.
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
 * the same shape `session/resume-store.ts` names on the voice side — a default
 * in the wrong place — so `useWorkflowSubmit` now mints the key and asks.
 *
 * `enabled` remains, because `recover: false` remains: a page whose form must
 * always open empty says so, and then nothing here runs.
 */

import type { WorkflowApi } from "./workflow-client.ts";

/** What a page's recovery needs; `_submission-state.ts` turns it into the lookup. */
export type RecoverRunOptions = {
  /** The workflow whose runs are indexed under `key`. */
  workflow: string;
  /** The caller's handle on its own run. `useDefaultRunKey` always supplies one. */
  key: string;
  /** Whether the caller asked for this at all — `recover` at the call site. */
  enabled: boolean;
  /** The stable getter from `useWorkflowApiRef`. */
  getClient: () => WorkflowApi;
};

/**
 * Look up the newest run for a key.
 *
 * @returns The run's id, or `undefined` for a key with no runs. A failure
 *   REJECTS, so the machine can report it — see "A failed lookup is REPORTED".
 */
export async function findRecoveredRun(
  client: WorkflowApi,
  workflow: string,
  key: string,
): Promise<string | undefined> {
  // The newest is the only one a form can show; the rest are what
  // `useWorkflowRuns` is for.
  const found = await client.find(workflow, key, { limit: 1 });
  return found[0]?.runId;
}
