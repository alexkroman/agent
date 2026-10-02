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
import { MAX_WORKFLOW_FIND_LIMIT, resolveFindLimit, type WorkflowKeyStore } from "./keys.ts";
import type { WdkAdapter, WdkRunRecord } from "./wdk-types.ts";

/** How many workflows' key lookups run at once — each is itself a bounded read. */
const WORKFLOW_LOOKUP_CONCURRENCY = 4;

/**
 * What a keyed read may narrow BEFORE a record becomes a snapshot.
 *
 * Applied to the raw WDK record, which already carries `createdAt` and
 * `status`, so a run the caller's filters would discard never becomes a
 * snapshot — and a caller that never reads `output` (`withOutput: false`) gets
 * none. The set of run ids read is unchanged: `lookup` is still asked for
 * `limit` of them.
 *
 * @internal
 */
export type KeyedReadScope = {
  /** Keep this record. Omitted, every record is kept. */
  keep?: (record: WdkRunRecord) => boolean;
  /** Read a completed run's output. Default true. */
  withOutput?: boolean;
};

/** `find` over one workflow, as `findByKey` and `cancelAll` call it. */
type FindOne = (
  workflow: string,
  key: string,
  limit: number,
  scope?: KeyedReadScope,
) => Promise<WorkflowRunSnapshot[]>;

/**
 * Build the one-workflow keyed `find` over the key index and the WDK adapter —
 * `WorkflowClient.find`, and the unit {@link findByKeyAcross} and
 * {@link cancelAllByKey} are composed of.
 *
 * @internal
 */
export function keyedFind(deps: {
  keys: WorkflowKeyStore;
  wdk: Pick<WdkAdapter, "getRun">;
  toSnapshot: (
    record: WdkRunRecord,
    key: string,
    withOutput?: boolean,
  ) => Promise<WorkflowRunSnapshot>;
  concurrency: number;
}): FindOne {
  const { keys, wdk, toSnapshot, concurrency } = deps;
  return async (name, key, limit, scope = {}) => {
    const runIds = await keys.lookup(name, key, limit);
    const records = await mapConcurrent(runIds, concurrency, (id) => wdk.getRun(id));
    // A recorded id whose run is gone is dropped rather than reported: runs
    // expire, and a `find` that threw because one of five results had aged out
    // would be useless exactly when history matters. The key stays indexed.
    const kept = records.filter(
      (r): r is WdkRunRecord => r !== undefined && (scope.keep?.(r) ?? true),
    );
    return await mapConcurrent(kept, concurrency, (r) => toSnapshot(r, key, scope.withOutput));
  };
}

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
  const kept = (createdAt: number, status: WorkflowRunSnapshot["status"]): boolean =>
    (since === undefined || createdAt >= since) && (statuses === undefined || statuses.has(status));
  // The filters run on the raw record first (see `KeyedReadScope`) and again on
  // the snapshot, which is what holds them for a `find` that ignores `scope`.
  const scope: KeyedReadScope = {
    keep: (r) => kept(new Date(r.createdAt).getTime(), r.status),
    withOutput: options.withOutput !== false,
  };
  const perWorkflow = await mapConcurrent(workflows, WORKFLOW_LOOKUP_CONCURRENCY, (name) =>
    find(name, key, limit, scope),
  );
  return perWorkflow
    .flat()
    .filter((run) => kept(run.createdAt, run.status))
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
