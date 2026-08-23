// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:workflow-api` epoch 10.
 *
 * **Epoch 10 is a SUBTRACTION, and epoch 9 is DROPPED** — `./v9.ts` read
 * `clampWorkflowWait` off this subpath and was deleted with it. Four names went
 * to `@alexkroman1/aai/internal`: the wait clamp, its ceiling
 * (`MAX_WORKFLOW_WAIT_MS`), the terminal-status list, and the route prefix.
 * Epoch 1 went too, for the prefix; epochs 2-8 name none of the four and
 * compile unchanged beside this file.
 *
 * `clampWorkflowWait` is the case worth recording. Its own doc says both ends
 * share the clamp, and the browser client does share it — through a RELATIVE
 * import inside `sdk/workflow-api-client.ts`. The public export existed so
 * `aai-runtime` could reach the same copy, which is a fact about our packaging
 * and not an affordance a caller ever used: `get(runId, { wait })` takes a
 * number and the client applies the cap, which `waited()` below is the evidence
 * for. Same shape for the prefix — a caller names routes through the client and
 * builds no URL.
 *
 * What this file freezes is that the CALLER's surface survived the cut intact:
 * one client, a run to read, a guard that narrows it, and the option bags that
 * stayed because they are `WorkflowClient`'s own parameter types.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { type AgentClient, createAgentClient } from "../../../sdk/agent-client.ts";
import type { WorkflowSummary } from "../../../sdk/workflow.ts";
import type { StartOptions } from "../../../sdk/workflow-options.ts";
import { isTerminal, type WorkflowRunSnapshot } from "../../../sdk/workflow-run.ts";

/** One client for the whole agent, built once — a fresh one per call is a fresh `fetch` closure. */
const agent: AgentClient = createAgentClient({
  baseUrl: "https://agent.example/",
  token: process.env.AAI_WORKFLOW_API_TOKEN,
});

/**
 * The guard is a TYPE guard, which is the point: the narrow leaves `status` as
 * the three-member terminal union and makes `output` present, so neither needs
 * asserting. It accepts `undefined` because that is what every call site holds
 * before the first poll lands.
 */
export function describeRun(run: WorkflowRunSnapshot<{ text: string }> | undefined): string {
  if (!isTerminal(run)) return "still going";
  return run.status === "completed" ? run.output.text : run.status;
}

/**
 * Long-polling with no clamp of the caller's own. A number over the ceiling is
 * not an error and not honoured either — the client caps it — which is why the
 * clamp and the cap were never a caller's business.
 */
export async function waited(runId: string): Promise<WorkflowRunSnapshot | undefined> {
  return await agent.get(runId, { wait: 300_000 });
}

/** The option bag a caller passing a correlation key builds. */
export const keyed: StartOptions = { key: "session_1" };

/** Rendering a form from what `GET /workflows` listed. */
export function formTitle(summary: WorkflowSummary): string {
  return summary.description ?? summary.name;
}
