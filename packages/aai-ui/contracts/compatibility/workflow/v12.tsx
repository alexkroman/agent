// Copyright 2026 the AAI authors. MIT license.

/**
 * Frozen authoring example: `aai-ui:workflow` epoch 12.
 *
 * **Nothing a page writes changed**, which is why epoch 11 is RETAINED and
 * `./v11.tsx` compiles unchanged beside this file. The epoch moved because the
 * SDK's run vocabulary — `isTerminal`, `WorkflowRunSnapshot`,
 * `WorkflowOutputOf`, `WorkflowSummary` — left `@alexkroman1/aai`'s root barrel
 * for `@alexkroman1/aai/workflow-api`, and this package re-exports them, so its
 * rolled-up `.d.ts` records a changed import specifier.
 *
 * What is worth freezing is that the move is invisible from a `client.tsx`,
 * which is the whole reason this package re-exports them at all: a page imports
 * from `@alexkroman1/aai-ui` and never from the SDK. Every name below is
 * reached through this package, and the guard still narrows the same way.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  isTerminal,
  type WorkflowOutputOf,
  type WorkflowRun,
  type WorkflowSummary,
} from "../../../index.ts";

/** What this workflow answers with. A page names it; nothing here infers it. */
type Transcript = { transcript: string; words: number };

/**
 * `isTerminal` is a TYPE guard, and that is what a page needs: inside the
 * branch, `status` is the three-member union and `output` is present.
 */
export function summarize(run: WorkflowRun<Transcript> | undefined): string {
  if (!isTerminal(run)) return "working…";
  return run.status === "completed" ? `${run.output.words} words` : run.status;
}

/** `WorkflowOutputOf` still names a workflow's output, reached through this package. */
export type Out = WorkflowOutputOf<{ run: () => Transcript }>;

/** And the listing a form renders itself from. */
export function title(summary: WorkflowSummary): string {
  return summary.description ?? summary.name;
}
