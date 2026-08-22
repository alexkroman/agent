// Copyright 2026 the AAI authors. MIT license.
/**
 * Epoch-1 TEMPLATE for `aai-runtime:keys` — the key-store starter as it was
 * written at epoch 1. Copy this file into your own host and edit the marked
 * points; it is meant to be taken, not read.
 *
 * **FROZEN.** This copy must keep compiling against current source for as long
 * as epoch 1 is supported, so a compile error here is the finding — never
 * something to edit away. Changing the API means a NEW epoch carrying a new
 * template, never an edit to this one. Imports of this package's own names are
 * relative (`../../../runtime-barrel.ts`) because the package cannot resolve
 * itself by name; `Db` comes from the SDK by package name, exactly as the source
 * declaring these signatures names it.
 *
 * ## What this is
 *
 * The correlation index a host wires up so an inbound caller reaches the run
 * they already started: one deployment-level decision, then the
 * record-then-look-up round trip every call performs. These are CORRELATION
 * keys — `(workflow, key) -> runId`, e.g. a phone number to its live run — not
 * credentials.
 *
 * ## What to change
 *
 * - {@link CALLER_WORKFLOW} — your workflow's name.
 * - The `db` you pass {@link keyStoreFor}: your app `Db` in a deployment.
 * - The `start` callback you pass {@link resumeOrStartRun} — that is where your
 *   host actually creates the run.
 *
 * ## What not to change
 *
 * Record the workflow's NAME, not its `workflowId`: an id embeds the source
 * file path, so moving a workflow between modules orphans every key already
 * recorded under the old one.
 *
 * Look up with a limit. `lookup` answers newest-first, so `1` IS "the current
 * run" and you never sort; an unbounded lookup on a busy agent is a scan of
 * every run it has ever started.
 */

import type { Db } from "@alexkroman1/aai";
import { resolveKeyStore, type WorkflowKeyStore } from "../../../runtime-barrel.ts";

/** The workflow whose runs are indexed by caller. ← your workflow's name. */
export const CALLER_WORKFLOW = "inbound-call";

/**
 * The one deployment-level decision, made once at boot.
 *
 * ← pass your app `Db` in a deployment: that yields the Postgres index, a
 * single table in the app's own schema, so it needs no second credential and is
 * reaped with the app. Passing `undefined` yields the in-memory index, which
 * forgets everything on restart — correct only where the runs it points at are
 * also in this process's memory (`aai dev` against the Local World), and wrong
 * anywhere else.
 *
 * The decision belongs to the DEPLOYMENT and never to a caller, which is why
 * this is one call at boot rather than an `if` at each call site: the index must
 * not end up more or less durable than the runs it indexes.
 */
export function keyStoreFor(db: Db | undefined): WorkflowKeyStore {
  return resolveKeyStore(db);
}

/**
 * The run to resume for this caller, or `undefined` on their first call.
 *
 * A key is deliberately not unique — a second start for the same caller records
 * a second run — so "the current run" is this READ, newest-first with a limit
 * of 1, rather than a write constraint.
 */
export async function currentRunFor(
  store: WorkflowKeyStore,
  workflow: string,
  key: string,
): Promise<string | undefined> {
  const runs = await store.lookup(workflow, key, 1);
  return runs[0];
}

/** What one inbound call resolved to. */
export type CallerRun = {
  /** The run this call is attached to. */
  runId: string;
  /** `true` when it was already running before this call arrived. */
  resumed: boolean;
};

/**
 * The round trip every inbound call performs: look up, else start and record.
 *
 * ← `start` is your host creating the run. Record AFTER it exists and with the
 * id it returned; a `record` that runs first can index a run that never
 * started, and a run started without one is unreachable from the next call —
 * which is the case this index exists for, since a durable run outlives the
 * session that began it.
 *
 * Let a failing `record` reject. Swallowing it leaves a live run nothing can
 * find again, which is worse than the call failing now.
 */
export async function resumeOrStartRun(
  store: WorkflowKeyStore,
  workflow: string,
  key: string,
  start: () => Promise<string>,
): Promise<CallerRun> {
  const existing = await currentRunFor(store, workflow, key);
  if (existing !== undefined) return { runId: existing, resumed: true };
  const runId = await start();
  await store.record(workflow, key, runId);
  return { runId, resumed: false };
}

/**
 * The whole wiring, as a host holds it.
 *
 * ← your key: whatever identifies the caller across calls (a phone number, a
 * customer id). It is stored as given, so normalize it here — once — rather
 * than at each call site, or the same caller indexes under two keys.
 */
export function callerRuns(
  db: Db | undefined,
  startRun: (key: string) => Promise<string>,
): (key: string) => Promise<CallerRun> {
  const store = keyStoreFor(db);
  return (key) => resumeOrStartRun(store, CALLER_WORKFLOW, key.trim(), () => startRun(key.trim()));
}
