// Copyright 2026 the AAI authors. MIT license.
/**
 * A stored run as the run API reads it — the one mapping both engines share.
 *
 * The production engine (`workflow/engine.ts`, over a journal) and the eval
 * engine (`eval/workflow-engine.ts`, in memory) each hold a run record of their
 * own and hand `workflow/client.ts` a {@link WdkRunRecord}. They wrote that
 * mapping twice, and the copies are exactly where a field added to one engine
 * goes missing from the other: `label` was the third field to cross, after
 * `output` and `error`, and a snapshot of an eval run would have dropped it
 * with nothing saying so. One function, so a new field is one edit.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { WdkRunRecord } from "./wdk-types.ts";

/** What either engine's record has, named the run API's way (`workflowName`). */
export type StoredRun = {
  runId: string;
  workflowName: string;
  status: WdkRunRecord["status"];
  createdAt: number;
  output?: unknown;
  error?: { message: string } | undefined;
  label?: string | undefined;
};

/**
 * `record` as a {@link WdkRunRecord}.
 *
 * Both payload fields ride the record, and both are gated on the status that
 * gives them meaning: a snapshot reads them from here rather than paying a
 * second read (`readOutput`) for a value this one already carries, so a mapping
 * that dropped `output` would report every completed run as having returned
 * nothing.
 */
export function toWdkRunRecord(record: StoredRun): WdkRunRecord {
  return {
    runId: record.runId,
    workflowName: record.workflowName,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.status === "completed" ? { output: record.output } : {}),
    ...(record.status === "failed" && record.error ? { error: record.error } : {}),
    ...omitUndefined({ label: record.label }),
  };
}
