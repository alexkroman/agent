// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:keys` epoch 1.
 *
 * **"Frozen" means this file must keep compiling against current source for as
 * long as epoch 1 is advertised as supported.** A compile error here is the
 * finding, not something to edit away. Imports of this package's own names are
 * RELATIVE (`../../../runtime-barrel.ts`) because the package cannot resolve
 * itself by name; `Db` comes from the SDK by package name, exactly as the source
 * that declares these signatures names it.
 *
 * The "keys" here are CORRELATION keys, not credentials: the index is
 * `(workflow, key) -> runId`, and it exists because the Workflow Development Kit
 * has no notion of tagging a run — `runs.list()` filters by workflow name and
 * status and nothing else, so "which run belongs to this phone number" is a
 * question it cannot be asked. That question is specifically a VOICE problem. A
 * durable run outlives the session that started it, and a session's own state is
 * swept shortly after the caller hangs up, so without this index the run is
 * unreachable from the next call — which is the case the whole feature is for.
 *
 * An interface, two implementations, and a resolver that picks between them. The
 * interesting part is that the choice is a property of the DEPLOYMENT and never
 * of the caller: what decides it is whether there is a database, so a host asks
 * {@link resolveKeyStore} the same question `configureWorkflowWorld` already
 * asks, and the index cannot end up more or less durable than the runs it
 * indexes.
 */

import type { Db } from "@alexkroman1/aai";
import {
  createMemoryKeyStore,
  createPostgresKeyStore,
  resolveKeyStore,
  type WorkflowKeyStore,
} from "../../../runtime-barrel.ts";

/**
 * The one call a host makes: hand over the app database, or `undefined`.
 *
 * This is the whole decision, and writing it as one call rather than as an `if`
 * at each host is what keeps the two arms from drifting. Passing a `Db` yields
 * the Postgres index — a single table in the app's own schema, so it needs no
 * second credential and is reaped along with the app. Passing `undefined` yields
 * the in-memory one, which is `aai dev` against the Local World: that world
 * already keeps its queue in this process's memory, so an index that forgot
 * itself on restart is no less durable than the runs it points at. Anything MORE
 * durable there would be dishonest about what dev mode is.
 */
export function keyStoreFor(db: Db | undefined): WorkflowKeyStore {
  return resolveKeyStore(db);
}

/**
 * The same choice spelled out, for a process that already knows its world.
 *
 * Worth having both: a host wiring itself from an environment wants the resolver
 * above, while a spec — or a harness deliberately exercising the Postgres arm
 * against a real database — names the implementation it means. Reaching for
 * {@link createMemoryKeyStore} in a DEPLOYMENT is the mistake this pair makes
 * visible rather than convenient.
 */
export function postgresOrMemory(db: Db | undefined): WorkflowKeyStore {
  return db === undefined ? createMemoryKeyStore() : createPostgresKeyStore(db);
}

/**
 * Note the run a caller's key just started.
 *
 * Called after the run is created, and the workflow's NAME is what is recorded
 * rather than its `workflowId`: an id embeds the source file path, so moving a
 * workflow between modules would orphan every key already recorded under the old
 * one. A key is deliberately not unique — a second `start` for the same caller
 * records a second run, and "the newest run for this key" is a READ rather than a
 * write constraint.
 */
export async function rememberRun(
  store: WorkflowKeyStore,
  workflow: string,
  key: string,
  runId: string,
): Promise<void> {
  await store.record(workflow, key, runId);
}

/**
 * The run to resume for this caller, or `undefined` on the first call.
 *
 * `lookup` answers newest-first, so a limit of 1 IS "the current one" and the
 * caller never sorts. The limit is required rather than optional because a
 * lookup with no ceiling on a busy agent is a scan of every run it has ever
 * started.
 */
export async function currentRunFor(
  store: WorkflowKeyStore,
  workflow: string,
  key: string,
): Promise<string | undefined> {
  const runs = await store.lookup(workflow, key, 1);
  return runs[0];
}

/**
 * Wrap a store to see what it is asked, without changing what it answers.
 *
 * The surface is two methods, which is what makes this cheap — a host that wants
 * per-workflow metrics, or a spec that wants to assert a key was recorded
 * exactly once across a retry, implements the interface rather than reaching
 * inside either backend. Note it delegates and returns; a decorator that
 * swallowed the rejection would turn a failed `record` into a run nothing can
 * find again.
 */
export function withObservedLookups(
  inner: WorkflowKeyStore,
  observe: (event: "record" | "lookup", workflow: string, key: string) => void,
): WorkflowKeyStore {
  return {
    async record(workflow, key, runId) {
      observe("record", workflow, key);
      await inner.record(workflow, key, runId);
    },
    async lookup(workflow, key, limit) {
      observe("lookup", workflow, key);
      return await inner.lookup(workflow, key, limit);
    },
  };
}
