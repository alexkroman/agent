// Copyright 2026 the AAI authors. MIT license.
/**
 * The real `WdkAdapter` — the only module in this package that imports the
 * Workflow Development Kit's runtime entry points.
 *
 * Keeping it to one module is what lets `workflow-client.ts` be unit-tested with
 * no world at all: `workflow/api`'s `start` and `getRun` resolve a World from the
 * environment when they are CALLED, so importing them anywhere on the client's
 * path would make every spec of it need a Postgres or a `.workflow-data/`
 * directory.
 *
 * Most methods are one line. The ones that are not are `getRun` (WDK signals "no
 * such run" by throwing, we signal it with `undefined`), `readOutput` (the run
 * must already be terminal, or the read blocks), and `wakeUp` (same
 * throw-vs-answer translation as `cancel`).
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { getRun, resumeHook, start } from "workflow/api";
import { EntityConflictError, HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";
import { getWorld } from "workflow/runtime";
import type { WdkAdapter, WdkRunRecord, WdkStreamOptions } from "./workflow-wdk-types.ts";

/**
 * One WDK run record as ours.
 *
 * Shared by the single-run read and the listing rather than written once per
 * call site: the two differ only in how they got the record, and a field added
 * to {@link WdkRunRecord} that reached only one of them would show up as a
 * listing that quietly omits it.
 *
 * The `error` spread is guarded on `status`, not on the value, so
 * `omitUndefined` is not the tool here — a `failed` record with no error still
 * has to lose the property rather than carry `undefined`.
 */
/**
 * Is this — or anything it WRAPS — the DevKit's "no such run"?
 *
 * `WorkflowRunNotFoundError.is` reads one error's `name`, and the DevKit does not
 * always hand its own error straight back: `wakeUp` re-throws as
 * `new Error(\`Failed to wake up run \${runId}: …\`, { cause: err })`
 * (`@workflow/core`'s `runtime/runs.js`). So the bare predicate answered false for
 * the one case it exists to catch, and a wake on a run that is gone — the
 * ORDINARY answer, since the question is "is it still waiting" — became a 500 on
 * the public API rather than `{ woken: 0 }`.
 *
 * Walking the chain rather than special-casing `wakeUp`, because the wrapping is
 * theirs to change and the next method to acquire one would fail the same way.
 * Bounded, so a cause cycle cannot hang the handler that is reporting an error.
 *
 * @internal Exported for its own spec — the wrapping is a third party's and the
 * predicate is the only thing standing between it and a 500.
 */
export function isRunNotFound(err: unknown): boolean {
  return causeChainHas(err, (at) => WorkflowRunNotFoundError.is(at));
}

/**
 * Is this — or anything it WRAPS — the DevKit refusing to move a run that is
 * already over?
 *
 * The second half of `cancel`'s answer, and it was missing. A world throws
 * `EntityConflictError("Cannot transition run from terminal state \"completed\"")`
 * rather than a not-found, so the predicate above answered false and the
 * documented `cancelled: false` was unreachable for the only case that produces
 * it in practice: a run that FINISHED between the render and the click.
 * Measured against a real Postgres world under `aai dev` — `DELETE
 * /workflows/runs/<id>` on a completed run answered `500 Internal server error`,
 * which is the two-tabs race the route's own comment says is ordinary.
 *
 * Not narrowed by message: the wording is a third party's, and inside `cancel`
 * the only entity a conflict can be about is the run being cancelled, so the
 * class alone already means "that run will not transition". Cancelling an
 * already-CANCELLED run does not reach here — the world accepts the same
 * terminal status again — which is why the failure only ever showed on
 * `completed` and `failed`.
 */
function isRunOver(err: unknown): boolean {
  return isRunNotFound(err) || causeChainHas(err, (at) => EntityConflictError.is(at));
}

/**
 * Walk an error's `cause` chain, bounded, asking `pred` of each link.
 *
 * Shared by both predicates above rather than written twice: the wrapping is the
 * DevKit's to change, and a second copy is the one that would not be updated.
 * Bounded, so a cause cycle cannot hang the handler that is reporting an error.
 */
function causeChainHas(err: unknown, pred: (at: unknown) => boolean): boolean {
  for (let at: unknown = err, depth = 0; at !== undefined && depth < 8; depth++) {
    if (pred(at)) return true;
    at = at instanceof Error ? at.cause : undefined;
  }
  return false;
}

/**
 * Is cancelling this run MOOT — already cancelled, or not there at all?
 *
 * The two cases {@link isRunOver} cannot report, and they are the two halves of
 * one clause in `WorkflowClient.cancel`'s contract: "false when it was already
 * terminal (or no such run exists)".
 *
 * - **Already `cancelled`** is the one terminal status a world accepts a second
 *   time, so nothing throws and the catch below has nothing to translate.
 * - **Gone** behaves differently per WORLD, which is what hid it. Postgres
 *   throws a not-found from `getRun(id).cancel()` and `isRunOver` answers it;
 *   the LOCAL world (`aai dev` with no `DATABASE_URL`, and every e2e run)
 *   resolves that call SILENTLY for an id that was never started, so the answer
 *   was `true` — "this call ended it", about a run that never existed.
 *   Measured under `aai dev`: `DELETE /workflows/runs/wrun_totally_made_up_id`
 *   answered `{"cancelled":true}` while `GET` on the same id answered 404 and
 *   `wake` answered `{"woken":0}`. Cancel was the one read of three that
 *   disagreed with the other two.
 *
 * A PROBE, not a gate: a read that cannot answer decides nothing and leaves the
 * write in charge, because a transient fault here would otherwise report a live
 * run as already over — the direction `cancel`'s own "an unrelated failure still
 * propagates" spec exists to protect. Only a not-found is conclusive, which is
 * why the catch asks rather than swallowing.
 *
 * `resolveData: "none"`, the same read `getRun` above takes: cancelling is a
 * human-initiated operation and one extra metadata read is not a path worth
 * optimizing against a wrong answer.
 */
async function cancelIsMoot(runId: string): Promise<boolean> {
  try {
    const record = await getWorld().runs.get(runId, { resolveData: "none" });
    return record.status === "cancelled";
  } catch (err: unknown) {
    return isRunNotFound(err);
  }
}

function toRunRecord(record: {
  runId: string;
  workflowName: string;
  status: WdkRunRecord["status"];
  createdAt: WdkRunRecord["createdAt"];
  error?: WdkRunRecord["error"];
}): WdkRunRecord {
  return {
    runId: record.runId,
    workflowName: record.workflowName,
    status: record.status,
    createdAt: record.createdAt,
    ...(record.status === "failed" && record.error ? { error: record.error } : {}),
  };
}

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
        return toRunRecord(await getWorld().runs.get(runId, { resolveData: "none" }));
      } catch (err: unknown) {
        // The only expected failure. Anything else — a lost database, a
        // serialization fault — must propagate: answering `undefined` for it
        // would report "no such run" for a run that exists, and a caller polling
        // one would conclude it had been swept.
        if (isRunNotFound(err)) return;
        throw err;
      }
    },

    async listRuns(workflowId: string, limit: number): Promise<WdkRunRecord[]> {
      const page = await getWorld().runs.list({
        // WDK's `workflowName` IS the compiler's identifier — its own docs call
        // the field machine-readable and parse it before display. Filtering it
        // by the key an agent declares a workflow under matches nothing.
        workflowName: workflowId,
        pagination: { limit },
        resolveData: "none",
      });
      return page.data.map(toRunRecord);
    },

    async cancel(runId: string): Promise<boolean> {
      // The two cases the catch below CANNOT see, read before the write
      // instead — an already-cancelled run on any world, and a missing one on a
      // world that stays quiet about it. See {@link cancelIsMoot}, which has
      // both measurements. `WorkflowClient.cancel` promises "true when this
      // call is what ended it", and `recap-workflow`'s `cancel_recap` is what
      // that costs: a caller who says "forget it" twice is told twice that it
      // stopped their run.
      if (await cancelIsMoot(runId)) return false;
      try {
        await getRun(runId).cancel();
        return true;
      } catch (err: unknown) {
        // `cancel` on an already-terminal run is not an error a caller should see
        // as one: `WorkflowClient.cancel` resolves false for "it was already
        // over", which is the same answer whether the run completed a second ago
        // or was never there. Both spellings of "already over" — see
        // {@link isRunOver}, which is what makes the second one reachable.
        if (isRunOver(err)) return false;
        throw err;
      }
    },

    async signal(token: string, payload: unknown): Promise<boolean> {
      try {
        await resumeHook(token, payload);
        return true;
      } catch (err: unknown) {
        // Third instance of the same translation as `cancel` and `wakeUp`: a
        // token nothing is listening on is an ANSWER. It is the ORDINARY answer
        // here, in fact — the run moved past its hook, finished, or was never
        // started — so a caller that had to catch this would catch it on the
        // happy path.
        if (HookNotFoundError.is(err)) return false;
        throw err;
      }
    },

    async wakeUp(runId: string, correlationIds: string[] | undefined): Promise<number> {
      try {
        // Same shape as `cancel`: a run that is gone is an ANSWER (nothing was
        // sleeping), not an error a caller should have to catch. `wakeUp` on a
        // live run that happens not to be sleeping already reports 0, so the two
        // cases are indistinguishable to a caller — which is correct, because
        // the question is "is it still waiting", and the answer is no either way.
        const { stoppedCount } = await getRun(runId).wakeUp(omitUndefined({ correlationIds }));
        return stoppedCount;
      } catch (err: unknown) {
        if (isRunNotFound(err)) return 0;
        throw err;
      }
    },

    async streamTail(runId: string, options: WdkStreamOptions): Promise<number> {
      // `getTailIndex` is a method WDK hangs on the readable, so the stream has
      // to be constructed to ask — and it MUST then be cancelled, because
      // constructing one is not free the way this used to claim.
      //
      // `getReadable()` hands back the readable end of a TransformStream that a
      // BACKGROUND PUMP (`flushablePipe` in `@workflow/core`) is already filling.
      // The pump pulls immediately, the pull calls `world.readFromStream`, and
      // the local world answers that by attaching a `chunk:<stream>` and a
      // `close:<stream>` listener to a process-wide emitter. `getTailIndex`
      // itself never touches the stream — it asks the world for
      // `getStreamInfo` — so every tail read left a whole live reader behind
      // with nobody to cancel it.
      //
      // That is one leaked pair per call, and this is called on the hot path:
      // `workflow-api-stream.ts` reads the tail before every
      // `GET /runs/:id/stream`, and a page watching a run's progress re-opens
      // that once a second. Measured against the real streamer, 15 tail reads
      // attached 15 pairs and freed none — Node's
      // `MaxListenersExceededWarning` at 11, then unbounded — and a leaked
      // reader is not merely idle: it is still mid-disk-read, so its chunk
      // listener copies every chunk the run writes afterwards into a buffer
      // nothing will drain (the measurement is in the #1196 commit message,
      // which fixed the OTHER leak into the same emitter).
      //
      // Cancelling propagates the whole way down: it errors the transform's
      // writable, the pump's `writer.closed` rejects, and its `finally` cancels
      // the world reader, which detaches both listeners. Verified against the
      // real `@workflow/world-local` streamer — 15 calls, 0 listeners left.
      const readable = getRun(runId).getReadable(omitUndefined(options));
      try {
        return await readable.getTailIndex();
      } finally {
        // Not awaited: the answer is already in hand, and a cancel that fails
        // has nothing to tell a caller who asked for an index.
        void readable.cancel().catch(() => undefined);
      }
    },

    readStream(runId: string, options: WdkStreamOptions): ReadableStream<unknown> {
      // The run lookup and the encryption-key resolution are deferred to the
      // first chunk, so a missing run surfaces at READ time rather than here —
      // but the stream itself is NOT free (see `streamTail` above: a background
      // pump opens a world reader straight away). **The caller must cancel it**,
      // read or not. `workflow-api-stream.ts` does so in a `finally`.
      return getRun(runId).getReadable(omitUndefined(options));
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
