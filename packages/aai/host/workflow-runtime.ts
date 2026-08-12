// Copyright 2026 the AAI authors. MIT license.
/**
 * One decision: does this runtime get a real `ctx.workflows`, and backed by what?
 *
 * Split from `runtime.ts` so `createRuntime` reads as one line, and from
 * `workflow-client.ts` so that module stays free of the Workflow DevKit import
 * (see `workflow-wdk.ts` for why that matters to its specs).
 *
 * The interesting part is the key store, because the two cases are not "prod and
 * a test" but two legitimate deployments:
 *
 * - **With `ctx.db`** — the correlation-key index is a table in the app's own
 *   schema. Every platform workflow app is here, which is why creating one
 *   switches storage on.
 * - **Without** — `aai dev` against the Local World, which keeps runs in
 *   `.workflow-data/` and needs no database. The index is then in memory and
 *   forgotten on restart, matching what the Local World already does to the runs
 *   themselves.
 *
 * A missing database is therefore NOT a reason to withhold the client. It was
 * tempting to make storage a hard requirement and have `ctx.workflows` reject
 * without it — but that breaks `aai dev` for every agent whose project has no
 * `DATABASE_URL`, which is the ordinary way to try a workflow out before
 * deploying it.
 */

import type { Db } from "../sdk/db.ts";
import type { AgentDef } from "../sdk/types.ts";
import type { WorkflowClient } from "../sdk/workflow.ts";
import type { Logger } from "./runtime-config.ts";
import { createWorkflowClient, resolveKeyStore } from "./workflow-client.ts";
import { wdkAdapter } from "./workflow-wdk.ts";

/**
 * Build `ctx.workflows` for one runtime, or `undefined` when the agent declares
 * no workflows.
 *
 * `undefined` rather than a rejecting client, so the ONE place that decides what
 * an unavailable client says is the tool executor
 * (`WORKFLOWS_UNAVAILABLE_MESSAGE`). Two producers of that message would drift,
 * and this one has less context to write a good one with.
 *
 * @internal
 */
export function buildWorkflowClient(
  // The state type is irrelevant here — only `agent.workflows` is read — and
  // `AgentDef<never>` would reject the runtime's `AgentDef<any>` on `state()`'s
  // return. `unknown` is the parameter that accepts any agent while still
  // requiring one.
  agent: Pick<AgentDef<unknown>, "workflows">,
  db: Db | undefined,
  logger: Logger,
): WorkflowClient | undefined {
  const workflows = agent.workflows;
  if (!workflows || Object.keys(workflows).length === 0) return;
  logger.info?.("Workflows resolved", {
    workflows: Object.keys(workflows),
    // Which store is in play decides whether a correlation key survives a
    // restart, so it belongs in the one line an operator reads at boot rather
    // than being inferred from whether storage happens to be on.
    keyStore: db ? "postgres" : "memory",
  });
  return createWorkflowClient({
    workflows,
    keys: resolveKeyStore(db),
    wdk: wdkAdapter(),
    logger,
  });
}
