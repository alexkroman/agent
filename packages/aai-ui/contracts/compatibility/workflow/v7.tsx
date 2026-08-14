// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 7.
 *
 * Epoch 7 added `<WorkflowProgress>` — the rendered half of
 * `useWorkflowProgress`, holding the three rules a page kept re-deriving: hide
 * until the agent has a stream AND the run has written to it, render the lines
 * as text (they are append-only and legitimately repeat, so there is no stable
 * key), and let them replay. Everything epoch 6 could express still compiles
 * (see `./v6.tsx`, retained for that reason); this file covers only what is new.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 */

import { createWorkflowApi, WorkflowProgress } from "../../../index.ts";

/** The whole of it: a run id. */
export function Narration({ runId }: { runId: string }) {
  return <WorkflowProgress runId={runId} />;
}

/** A page may pass its own state straight through before a run exists. */
export function MaybeNarration({ runId }: { runId?: string | undefined }) {
  return <WorkflowProgress runId={runId} />;
}

/** Styled by the caller, with a placeholder for the pre-first-line frame. */
export function StyledNarration({ runId }: { runId: string }) {
  return (
    <WorkflowProgress runId={runId} className="font-mono text-xs" placeholder={<p>Starting…</p>} />
  );
}

/** …and against a client the page built itself. */
const api = createWorkflowApi();

export function NarrationOnOwnClient({ runId }: { runId: string }) {
  return <WorkflowProgress runId={runId} api={api} />;
}
