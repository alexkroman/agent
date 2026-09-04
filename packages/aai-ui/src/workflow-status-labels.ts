// Copyright 2026 the AAI authors. MIT license.
/**
 * One line describing where a run has got to, for each status there is.
 *
 * Two template pages carried a byte-identical `Record<WorkflowRun["status"],
 * string>` with the same doc comment, differing only in the `running` label —
 * which is the one a page really does want to write for itself ("Writing…",
 * "Transcribing…") and the only one. The other four are the same sentence about
 * the same five-member union everywhere.
 *
 * The exhaustiveness argument both copies were written for survives, and moves
 * to the SDK boundary: this is a `Record` over {@link WorkflowRunStatus} rather
 * than a `switch`, so a status added to the SDK is a compile error HERE — in one
 * place that every page then inherits — instead of falling through a `default:`
 * in each of them into whichever line was last. A page overriding one member
 * keeps that: spreading a complete record cannot drop a key.
 */

import type { WorkflowRunStatus } from "@alexkroman1/aai/workflow-api";

/**
 * The default status line per {@link WorkflowRunStatus}.
 *
 * Override the ones your page has a better word for and keep the rest:
 *
 * ```ts
 * import { WORKFLOW_STATUS_LABELS } from "@alexkroman1/aai-ui";
 *
 * const STATUS_LINE = { ...WORKFLOW_STATUS_LABELS, running: "Writing…" };
 * ```
 *
 * The wording is deliberately about the RUN rather than about the work — a page
 * knows what its workflow does and this does not, so `running` is the neutral
 * "Working…" and every page that cares replaces exactly that key.
 *
 * @public
 */
export const WORKFLOW_STATUS_LABELS: Readonly<Record<WorkflowRunStatus, string>> = {
  pending: "Queued",
  running: "Working…",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
