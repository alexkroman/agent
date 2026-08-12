// Copyright 2026 the AAI authors. MIT license.
/**
 * The real {@link WdkAdapter} — the only module in this package that imports the
 * Workflow Development Kit's runtime entry points.
 *
 * Keeping it to one module is what lets `workflow-client.ts` be unit-tested with
 * no world at all: `workflow/api`'s `start` and `getRun` resolve a World from the
 * environment when they are CALLED, so importing them anywhere on the client's
 * path would make every spec of it need a Postgres or a `.workflow-data/`
 * directory.
 *
 * Three of the five methods are one line. The two that are not are `getRun` (WDK
 * signals "no such run" by throwing, we signal it with `undefined`) and
 * `readOutput` (the run must already be terminal, or the read blocks).
 */

import { getRun, start } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/errors";
import { getWorld } from "workflow/runtime";
import type { WdkAdapter, WdkRunRecord } from "./workflow-client.ts";

/**
 * The adapter over the installed WDK.
 *
 * A function rather than a constant so nothing resolves a World at import time —
 * `getWorld()` reads `WORKFLOW_TARGET_WORLD` and its world-specific
 * configuration, which the guest sets up as it boots.
 *
 * @internal
 */
export function wdkAdapter(): WdkAdapter {
  return {
    async start(workflowId: string, args: unknown[]): Promise<string> {
      // `{ workflowId }` is a supported overload (`WorkflowMetadata`), not a
      // trick: WDK's own `start` reads that property off whatever it is handed,
      // which is how a workflow can be started without importing its module.
      // That matters here because the agent bundle holds the CLIENT-transformed
      // body, whose call throws by design.
      const run = await start({ workflowId }, args);
      return run.runId;
    },

    async getRun(runId: string): Promise<WdkRunRecord | undefined> {
      try {
        const record = await getWorld().runs.get(runId, { resolveData: "none" });
        return {
          runId: record.runId,
          workflowName: record.workflowName,
          status: record.status,
          createdAt: record.createdAt,
          ...(record.status === "failed" && record.error ? { error: record.error } : {}),
        };
      } catch (err: unknown) {
        // The only expected failure. Anything else — a lost database, a
        // serialization fault — must propagate: answering `undefined` for it
        // would report "no such run" for a run that exists, and a caller polling
        // one would conclude it had been swept.
        if (WorkflowRunNotFoundError.is(err)) return;
        throw err;
      }
    },

    async listRuns(workflowName: string, limit: number): Promise<WdkRunRecord[]> {
      const page = await getWorld().runs.list({
        workflowName,
        pagination: { limit },
        resolveData: "none",
      });
      return page.data.map((record) => ({
        runId: record.runId,
        workflowName: record.workflowName,
        status: record.status,
        createdAt: record.createdAt,
        ...(record.status === "failed" && record.error ? { error: record.error } : {}),
      }));
    },

    async cancel(runId: string): Promise<boolean> {
      try {
        await getRun(runId).cancel();
        return true;
      } catch (err: unknown) {
        // `cancel` on an already-terminal run is not an error a caller should see
        // as one: `WorkflowClient.cancel` resolves false for "it was already
        // over", which is the same answer whether the run completed a second ago
        // or was never there.
        if (WorkflowRunNotFoundError.is(err)) return false;
        throw err;
      }
    },

    readOutput(runId: string): Promise<unknown> {
      // MUST only be called once the run is observed `completed` — see
      // `toSnapshot`. `returnValue` polls a non-terminal run at 1s intervals with
      // no ceiling, so calling it speculatively turns a snapshot read into a wait
      // for the whole run.
      return getRun(runId).returnValue;
    },
  };
}

/**
 * Start the world's queue subscription, when the configured world has one.
 *
 * The Postgres World's queue is graphile-worker POLLING the database, so nothing
 * runs until a long-lived process subscribes — `start()` is that subscription,
 * and without it a run sits `pending` forever with no error anywhere. The Local
 * World has no `start`, hence the optional call.
 *
 * **This is also the seam where the platform's sandbox lifetime meets WDK's
 * assumption of a long-lived server.** A Modal sandbox is idle-exited, so the
 * subscription dies with it and a run due in six hours has nobody polling for it;
 * booting the sandbox when work comes due is the platform's job, and is what
 * `aai-server`'s wake sweep exists for.
 *
 * @internal
 */
export async function startWorkflowWorld(): Promise<void> {
  await getWorld().start?.();
}
