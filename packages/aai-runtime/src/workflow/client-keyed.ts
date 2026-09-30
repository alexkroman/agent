// Copyright 2026 the AAI authors. MIT license.
/**
 * The two correlation-key reads that span more than one call:
 * `ctx.workflows.findByKey` (every workflow, one key) and `cancelAll` (one
 * workflow, one key, every unfinished run).
 *
 * Both are COMPOSED of `find` and `cancel` rather than being new store
 * queries, and that is the design: the key index (`workflow/keys.ts`) is keyed
 * by `(workflow, key)` in all three backends — the platform's table among them,
 * which no tenant may migrate — so a cross-workflow read is N indexed lookups,
 * the same N an app wrote by hand, with the merge written once. Split out of
 * `workflow/client.ts`, which is at the file-length cap.
 */

import { mapConcurrent } from "@alexkroman1/aai/step";
import type { FindByKeyOptions, WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { MAX_WORKFLOW_FIND_LIMIT, resolveFindLimit } from "./keys.ts";

/** How many workflows' key lookups run at once — each is itself a bounded read. */
const WORKFLOW_LOOKUP_CONCURRENCY = 4;

/** `find` over one workflow, as `findByKey` and `cancelAll` call it. */
type FindOne = (workflow: string, key: string, limit: number) => Promise<WorkflowRunSnapshot[]>;

/**
 * Newest first by creation time, the run id breaking a tie — the order `find`
 * promises within one workflow, extended across several.
 */
function newestFirst(a: WorkflowRunSnapshot, b: WorkflowRunSnapshot): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? 1 : -1;
}

/**
 * Runs started with `key` across `workflows`, merged newest first, filtered and
 * capped as {@link FindByKeyOptions} says.
 *
 * Each workflow is read to the same `limit` BEFORE the filters apply, so a
 * `statuses` filter sees at most that many of each workflow's newest runs —
 * the bound every keyed read has (`MAX_WORKFLOW_FIND_LIMIT`).
 *
 * @internal
 */
export async function findByKeyAcross(
  workflows: readonly string[],
  find: FindOne,
  key: string,
  options: FindByKeyOptions = {},
): Promise<WorkflowRunSnapshot[]> {
  const limit = resolveFindLimit(options.limit);
  const since = options.since instanceof Date ? options.since.getTime() : options.since;
  const statuses = options.statuses === undefined ? undefined : new Set(options.statuses);
  const perWorkflow = await mapConcurrent(workflows, WORKFLOW_LOOKUP_CONCURRENCY, (name) =>
    find(name, key, limit),
  );
  return perWorkflow
    .flat()
    .filter((run) => since === undefined || run.createdAt >= since)
    .filter((run) => statuses === undefined || statuses.has(run.status))
    .sort(newestFirst)
    .slice(0, limit);
}

/**
 * Cancel every unfinished run of `workflow` started with `key`, resolving how
 * many of those cancels were the ones that ended their run.
 *
 * Sequential, not concurrent: the list is short (a key's unfinished runs), and
 * each `cancel` is a compare-and-set whose `false` — the run finished first —
 * is simply not counted.
 *
 * @internal
 */
export async function cancelAllByKey(
  workflow: string,
  find: FindOne,
  cancel: (runId: string) => Promise<boolean>,
  key: string,
): Promise<number> {
  const runs = await find(workflow, key, MAX_WORKFLOW_FIND_LIMIT);
  let cancelled = 0;
  for (const run of runs) {
    if (run.status !== "pending" && run.status !== "running") continue;
    if (await cancel(run.runId)) cancelled++;
  }
  return cancelled;
}
