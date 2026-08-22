// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow-api` epoch 9.
 *
 * Epoch 9 is purely ADDITIVE — epoch 8 is retained and `./v8.ts` compiles
 * unchanged beside this file. What arrived is the RUN vocabulary, which used to
 * be on the root barrel beside `agent()` and `tool()`: the four option bags, the
 * status union and its terminal set, the snapshot a caller reads and its guard,
 * `WorkflowOutputOf`, `WorkflowSummary`, and the wait cap both ends clamp with.
 *
 * They belong here because the reader is never `agent.ts`. A page renders a run
 * and a script polls one — both already import `createWorkflowApiClient` from
 * this subpath — while an `agent.ts` writes `workflow()` and never names a
 * snapshot. Seventeen names against a root barrel whose stated membership test
 * is "would an `agent.ts`, a tool module, or a `workflow()` NAME it".
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import type { WorkflowSummary } from "../../../sdk/workflow.ts";
import type { StartOptions } from "../../../sdk/workflow-options.ts";
import {
  clampWorkflowWait,
  isTerminal,
  type WorkflowRunSnapshot,
} from "../../../sdk/workflow-run.ts";

/**
 * The guard is a TYPE guard, which is the point: the narrow it performs leaves
 * `status` as the three-member terminal union and makes `output` present, so
 * neither needs asserting. It accepts `undefined` because that is what every
 * call site holds before the first poll lands.
 */
export function describeRun(run: WorkflowRunSnapshot<{ text: string }> | undefined): string {
  if (!isTerminal(run)) return "still going";
  return run.status === "completed" ? run.output.text : run.status;
}

/** A page sizing its own `fetch` deadline from the same function the agent clamps with. */
export function waitBudget(requested: number | undefined): number {
  return clampWorkflowWait(requested);
}

/** Rendering a form from what `GET /workflows` listed. */
export function formTitle(summary: WorkflowSummary): string {
  return summary.description ?? summary.name;
}

/** The option bag a caller passing a correlation key builds. */
export const keyed: StartOptions = { key: "session_1" };
