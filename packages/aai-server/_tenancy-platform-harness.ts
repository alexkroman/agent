// Copyright 2026 the AAI authors. MIT license.
/**
 * The arm that runs the REAL statements: every op dispatched to the platform
 * store function that serves it, over a real `SqlExec`.
 *
 * This is the only arm that can see a tenancy leak in the SQL, because a leak
 * of that class lives in a `where` clause. An in-memory fake holds JS values and
 * a recorder replays statement text; neither can answer "does this predicate
 * really constrain", which is the whole question — and it is why the target leak
 * (`setStatus`'s `released` CTE losing `h.slug = $1`) survives a text gate: the
 * statement still carries `slug = $1` on its `moved` arm afterwards.
 *
 * ## The audit reads the tables directly, and that is not circular
 *
 * `dumpAll` is eight plain `where slug = any($1)` selects. Those trust a slug
 * filter, which is the very thing under test — but they are not the subject: the
 * SUBJECT is the twelve journal, five upload and six session-state statements
 * that ran before them. A three-line select whose predicate is its only clause
 * is the simplest thing in reach that can say what a tenant's rows are, and if
 * `setStatus` deleted a neighbour's hook, that neighbour's select comes back
 * short. The audit and the store cannot be wrong the same way, because the audit
 * writes nothing.
 *
 * ## `reset` deletes the AGENTS rows
 *
 * Every table here cascades from `aai_platform.agents`, so one delete per tenant
 * empties all eight — which matters because shrinking re-runs the property dozens
 * of times and a leftover row from an earlier run would converge the shrinker on
 * a counterexample that is really contamination.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { HookOp, RunOp, StepOp } from "./_tenancy-journal-harness.ts";
import {
  type Answer,
  emptyDump,
  type Op,
  SLUGS,
  type Slug,
  sortTenantDump,
  type TenantDump,
} from "./_tenancy-ops-harness.ts";
import type { SessionOp, UploadOp } from "./_tenancy-state-harness.ts";
import {
  isHookOp,
  isRunOp,
  isStepOp,
  isUploadOp,
  type TenancyStore,
} from "./_tenancy-world-harness.ts";
import * as state from "./platform-session-state.ts";
import * as uploads from "./platform-uploads.ts";
import * as journal from "./platform-workflow-journal.ts";
import type { SqlExec } from "./secret-store.ts";

/** `bigint` arrives as a STRING from the driver; `null` means absent. */
const num = (value: unknown): number => Number(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const str = (value: unknown): string => String(value);

/** Mirrors `platform-uploads.ts`'s own `partsOf`, which drops anything malformed. */
function partsOf(value: unknown): { at: number; bytes: number }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) ? [{ at: num(entry.at), bytes: num(entry.bytes) }] : [],
  );
}

/** `createRun`, `getRun`, `listRuns`, `setStatus`. */
async function applyRun(sql: SqlExec, op: RunOp): Promise<Answer> {
  switch (op.t) {
    case "createRun":
      try {
        await journal.createRun(sql, op.slug, {
          runId: op.runId,
          workflow: op.workflow,
          status: "pending",
          createdAt: op.createdAt,
          input: op.input,
        });
        return { ok: undefined };
      } catch (err) {
        if (err instanceof journal.PlatformWorkflowRunTakenError) return { refused: "run-taken" };
        throw err;
      }
    case "getRun":
      return { ok: await journal.getRun(sql, op.slug, op.runId) };
    case "listRuns":
      return { ok: await journal.listRuns(sql, op.slug, op.workflow, op.limit) };
    case "setStatus":
      return {
        ok: await journal.setStatus(sql, op.slug, op.runId, op.status, op.result, op.expect),
      };
    default:
      throw new Error("the platform arm reached a run op it does not dispatch");
  }
}

/** `appendStep`, `readSteps`, `claimAttempt`, `claimSleep`, `wakeSleeps`. */
async function applyStep(sql: SqlExec, op: StepOp): Promise<Answer> {
  switch (op.t) {
    case "appendStep":
      return {
        ok: await journal.appendStep(sql, op.slug, op.runId, {
          key: op.key,
          name: `st-${op.key}`,
          status: op.status,
          output: op.output,
          error: undefined,
          attempts: 1,
          startedAt: undefined,
          finishedAt: op.finishedAt,
        }),
      };
    case "readSteps":
      return { ok: await journal.readSteps(sql, op.slug, op.runId) };
    case "claimAttempt":
      return {
        // The op names its own holder — a charge is a lease held by a WALK, so
        // which walk is claiming is part of the operation. The window is
        // generous: these programs run in under a second, so nothing ages out
        // and the property stays about TENANCY.
        ok: await journal.claimAttempt(sql, op.slug, op.runId, op.key, op.holder, 60_000),
      };
    case "claimSleep":
      return {
        ok: await journal.claimSleep(
          sql,
          op.slug,
          op.runId,
          op.key,
          op.wakeAt,
          op.correlationId,
          op.kind,
        ),
      };
    case "wakeSleeps":
      return { ok: await journal.wakeSleeps(sql, op.slug, op.runId, op.now, op.correlationIds) };
    default:
      throw new Error("the platform arm reached a step op it does not dispatch");
  }
}

/** `claimHook`, `deliverHook`, `closeHook`. */
async function applyHook(sql: SqlExec, op: HookOp): Promise<Answer> {
  switch (op.t) {
    case "claimHook":
      try {
        return { ok: await journal.claimHook(sql, op.slug, op.runId, op.key, op.token) };
      } catch (err) {
        if (!(err instanceof journal.PlatformWorkflowHookTokenError)) throw err;
        // The MESSAGE is the only place the holding run appears, and a leak
        // would reveal a neighbour's run id there — so it is parsed back out
        // rather than dropped, and the reference computes the same holder.
        return {
          refused: "hook-token",
          holder: /already held by run (.+)$/.exec(err.message)?.[1],
        };
      }
    case "deliverHook":
      return { ok: await journal.deliverHook(sql, op.slug, op.token, op.payload) };
    case "closeHook":
      return { ok: await journal.closeHook(sql, op.slug, op.runId, op.key) };
    default:
      throw new Error("the platform arm reached a hook op it does not dispatch");
  }
}

/** `platform-uploads.ts`'s five. */
async function applyUpload(sql: SqlExec, op: UploadOp): Promise<Answer> {
  switch (op.t) {
    case "claimUpload":
      try {
        await uploads.claimUpload(sql, op.slug, op.id, {
          name: op.name,
          type: "audio/wav",
          size: 0,
          complete: false,
          expected: op.expected,
          parts: [],
        });
        return { ok: undefined };
      } catch (err) {
        if (err instanceof uploads.PlatformUploadIdTakenError) return { refused: "upload-taken" };
        throw err;
      }
    case "insertUpload":
      await uploads.insertUpload(sql, op.slug, op.id, {
        name: op.name,
        type: "text/plain",
        size: op.size,
        complete: true,
        expected: undefined,
        parts: [{ at: 0, bytes: op.size }],
      });
      return { ok: undefined };
    case "updateUpload":
      await uploads.updateUpload(sql, op.slug, op.id, {
        size: op.size,
        complete: op.complete,
        parts: [{ at: 0, bytes: op.size }],
      });
      return { ok: undefined };
    case "finishUpload":
      await uploads.finishUpload(sql, op.slug, op.id, op.size);
      return { ok: undefined };
    case "readUpload":
      return { ok: await uploads.readUpload(sql, op.slug, op.id) };
    default:
      throw new Error("the platform arm reached an upload op it does not dispatch");
  }
}

/** `platform-session-state.ts`'s six. */
async function applyState(sql: SqlExec, op: SessionOp): Promise<Answer> {
  switch (op.t) {
    case "commitSlots":
      await state.commitSlots(sql, op.slug, op.sessionId, op.values);
      return { ok: undefined };
    case "loadSlots":
      return { ok: await state.loadSlots(sql, op.slug, op.sessionId) };
    case "appendEvents":
      await state.appendEvents(sql, op.slug, op.sessionId, op.events);
      return { ok: undefined };
    case "readEvents":
      return { ok: await state.readEvents(sql, op.slug, op.sessionId, op.startIndex, op.limit) };
    case "nextEventIndex":
      return { ok: await state.nextEventIndex(sql, op.slug, op.sessionId) };
    case "discardSession":
      await state.discardSession(sql, op.slug, op.sessionId);
      return { ok: undefined };
    default:
      throw new Error("the platform arm reached a session op it does not dispatch");
  }
}

/** One op to the statement that serves it, by the same families the world uses. */
function applyOp(sql: SqlExec, op: Op): Promise<Answer> {
  if (isRunOp(op)) return applyRun(sql, op);
  if (isStepOp(op)) return applyStep(sql, op);
  if (isHookOp(op)) return applyHook(sql, op);
  if (isUploadOp(op)) return applyUpload(sql, op);
  return applyState(sql, op);
}

/** One table's worth of audit rows, both tenants at once. */
type Reader = (table: string, columns: string) => Promise<Record<string, unknown>[]>;

/** The five journal tables. */
async function readJournal(
  read: Reader,
  into: (row: Record<string, unknown>) => TenantDump | undefined,
): Promise<void> {
  for (const row of await read(
    "workflow_runs",
    "run_id, workflow, status, created_at, input::text as input, output::text as output, error",
  )) {
    into(row)?.runs.push({
      runId: str(row.run_id),
      workflow: str(row.workflow),
      status: str(row.status),
      createdAt: num(row.created_at),
      input: text(row.input),
      output: text(row.output),
      error: text(row.error),
    });
  }
  for (const row of await read(
    "workflow_steps",
    "run_id, key, status, output::text as output, attempts, finished_at",
  )) {
    into(row)?.steps.push({
      runId: str(row.run_id),
      key: str(row.key),
      status: str(row.status),
      output: text(row.output),
      attempts: num(row.attempts),
      finishedAt: num(row.finished_at),
    });
  }
  // `holders` is a MAP of holder to when it claimed, so the census reads its
  // SIZE: what a tenant boundary is about is that a charge appears under one
  // slug and not the other, and the holder names are the walk's business.
  for (const row of await read(
    "workflow_attempt_leases",
    "run_id, key, (select count(*) from jsonb_object_keys(holders)) as n",
  )) {
    into(row)?.attempts.push({ runId: str(row.run_id), key: str(row.key), n: num(row.n) });
  }
  for (const row of await read(
    "workflow_sleeps",
    "run_id, key, wake_at, woken, correlation_id, kind",
  )) {
    into(row)?.sleeps.push({
      runId: str(row.run_id),
      key: str(row.key),
      wakeAt: num(row.wake_at),
      woken: row.woken === true,
      correlationId: text(row.correlation_id),
      kind: str(row.kind),
    });
  }
  for (const row of await read(
    "workflow_hooks",
    "run_id, key, token, delivered, payload::text as payload, closed",
  )) {
    into(row)?.hooks.push({
      runId: str(row.run_id),
      key: str(row.key),
      token: str(row.token),
      delivered: row.delivered === true,
      payload: text(row.payload),
      closed: row.closed === true,
    });
  }
}

/** The upload records and the two session-state tables. */
async function readState(
  read: Reader,
  into: (row: Record<string, unknown>) => TenantDump | undefined,
): Promise<void> {
  for (const row of await read(
    "workflow_uploads",
    "id, name, type, size, complete, expected, parts",
  )) {
    into(row)?.uploads.push({
      id: str(row.id),
      name: str(row.name),
      type: str(row.type),
      size: num(row.size),
      complete: row.complete === true,
      expected: row.expected === null ? undefined : num(row.expected),
      parts: partsOf(row.parts),
    });
  }
  for (const row of await read("session_slots", "session_id, slot, value::text as value")) {
    into(row)?.slots.push({
      sessionId: str(row.session_id),
      slot: str(row.slot),
      value: str(row.value),
    });
  }
  for (const row of await read("session_events", "session_id, event_index, event::text as event")) {
    into(row)?.events.push({
      sessionId: str(row.session_id),
      index: num(row.event_index),
      event: str(row.event),
    });
  }
}

/** The eight audit reads. */
async function dumpAll(sql: SqlExec): Promise<Record<Slug, TenantDump>> {
  const out = {} as Record<Slug, TenantDump>;
  for (const slug of SLUGS) out[slug] = emptyDump();
  const into = (row: Record<string, unknown>): TenantDump | undefined => out[str(row.slug) as Slug];
  const read: Reader = (table, columns) =>
    sql(`select slug, ${columns} from aai_platform.${table} where slug = any($1::text[])`, [
      [...SLUGS],
    ]);

  await readJournal(read, into);
  await readState(read, into);
  for (const slug of SLUGS) out[slug] = sortTenantDump(out[slug] ?? emptyDump());
  return out;
}

/**
 * The platform arm over a real `SqlExec`.
 *
 * The agents rows are re-seeded on every `reset` because the delete that empties
 * the eight tables is the delete that removes them — the cascade IS the cleanup.
 * The column list is the shipped table's every NOT NULL with no default, spelled
 * out rather than derived, so a new required column fails HERE instead of this
 * harness silently testing a shape the migration does not have.
 */
export function createPlatformArm(sql: SqlExec): TenancyStore {
  return {
    reset: async () => {
      await sql("delete from aai_platform.agents where slug = any($1::text[])", [[...SLUGS]]);
      for (const slug of SLUGS) {
        await sql(
          `insert into aai_platform.agents
             (slug, credential_hashes, worker_hash, client_files, version)
           values ($1, '{}'::jsonb, '', '{}'::jsonb, 1)`,
          [slug],
        );
      }
    },
    apply: (op) => applyOp(sql, op),
    dumpAll: () => dumpAll(sql),
  };
}
