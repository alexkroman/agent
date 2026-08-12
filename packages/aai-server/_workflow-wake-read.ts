// Copyright 2026 the AAI authors. MIT license.
/**
 * The READ half of the durable-run wake sweep: which agents have work due right
 * now, according to the hints their guests published.
 *
 * Split from `workflow-wake.ts` — which owns the POLICY (what to do about a due
 * agent: the backoff, the per-tick cap, the interval) — along the seam the two
 * halves already had: this file is one transaction's worth of SQL over the
 * platform's admin connection, and it decides nothing. Read `workflow-wake.ts`
 * first; its module doc carries the design, the cost, and why the platform reads
 * a guest-published hint instead of the DevKit's queue.
 *
 * Three properties of the transaction are load-bearing, and each is a way this
 * went wrong before it was written down:
 *
 * - **The leader lock is TRANSACTION-scoped** (`pg_try_advisory_xact_lock`), so
 *   it is released by the commit with no unlock bookkeeping. A session-scoped
 *   lock leaked onto a pooled connection by a pass that threw is exactly the
 *   hazard `platform-lock.ts` has to guard against explicitly.
 * - **The statement timeout is `set local`**, so it dies with the transaction.
 *   A bare `set` rides the released connection back into every other platform
 *   query — a 5s ceiling on Vault reads and agents-row lookups, from a
 *   janitorial sweep.
 * - **Each tenant's read sits in a SAVEPOINT.** The hint table is tenant-owned,
 *   so a dropped, reshaped, or hugely-grown one makes that read fail — and a
 *   failed statement aborts the whole transaction, which without a savepoint
 *   means the FIRST broken tenant costs every later tenant its wake in the same
 *   pass. That is a cross-tenant denial of the only mechanism a parked run has.
 */

import { type ReservedDb, WORKFLOW_WAKE_TABLE } from "@alexkroman1/aai/runtime";
import { debug } from "./_debug-log.ts";
import { appDbIdentifier } from "./app-database.ts";
import type { AdminDb } from "./platform-lock.ts";
import type { BundleStore } from "./store-types.ts";

/**
 * Advisory-lock namespace for the wake sweep — the first of the two-int key,
 * distinct from `SLUG_LOCK_NAMESPACE` for the reason that one gives: a shared
 * namespace makes two unrelated operations serialize, which is invisible until
 * it is a latency mystery. Here it would be worse than invisible, since the
 * sweep SKIPS rather than waits: a collision with a slug lock would look like
 * "the sweep never runs while anything is deploying".
 */
export const WORKFLOW_WAKE_NAMESPACE = 0x41_41_49_02;

/** The sweep is one global operation, so the second key slot is a constant. */
const WORKFLOW_WAKE_LOCK_KEY = 1;

/**
 * `try_` rather than a wait, because a tick another replica is already running
 * is a tick this one has nothing to add to.
 */
const TRY_LOCK_SQL = "select pg_try_advisory_xact_lock($1::int, $2::int) as locked";

/**
 * Which candidate schemas have a hint table at all.
 *
 * Catalog-only, so it cannot be poisoned by what a tenant put IN the table, and
 * it is what keeps the per-schema reads below to the agents that actually run
 * workflows: an app with storage and no workflows never gets a table, and never
 * costs a read.
 */
const HINT_SCHEMAS_SQL = `select table_schema
from information_schema.tables
where table_name = $1 and table_type = 'BASE TABLE' and table_schema = any($2::text[])`;

/**
 * Read one app's hint, already filtered to "due".
 *
 * `min` and `where wake_at <= now()` are both deliberate. The filter runs in the
 * DATABASE so the comparison uses the same clock the guest wrote against — a
 * replica's clock skew must not decide whether a run resumes — and a null result
 * then means "not due" with no second interpretation. `min` rather than `max`
 * errs toward waking: the table holds one row by construction, and if a tenant
 * made it hold more, the earliest is the reading that cannot strand a run.
 *
 * The schema is interpolated because an identifier cannot be a bind parameter;
 * it comes from {@link appDbIdentifier} (a hex digest) and is re-asserted before
 * use, the same rule `app-database.ts` states for its DDL.
 */
function dueHintSql(schema: string): string {
  return `select min(wake_at) as wake_at from "${schema}"."${WORKFLOW_WAKE_TABLE}"
where wake_at <= now()`;
}

/** Guards the one interpolation above. `appDbIdentifier` can only produce this. */
const IDENTIFIER_RE = /^app_[a-f0-9]{16}$/;

/** What the read phase found: the due slugs, or that another replica has the lock. */
export type DueRead = {
  /** False when another replica is running this tick's pass. */
  locked: boolean;
  /** Agents with a hint table (i.e. that run workflows). */
  candidates: number;
  /** Slugs whose hint says work is claimable now. */
  due: string[];
};

/**
 * The "this pass does nothing" answer, for both ways a pass can reach it: another
 * replica holds the lock, or the read itself failed. `workflow-wake.ts` treats
 * them identically — there is nothing to wake either way — so one value keeps the
 * caller from having to invent a second empty shape for the failure path.
 */
export const NOT_LOCKED: DueRead = { locked: false, candidates: 0, due: [] };

export type ReadDueOptions = {
  adminDb: AdminDb;
  /** Slug enumeration — the guard against reading a deleted agent's leftovers. */
  store: BundleStore;
  /** `set local statement_timeout` for the pass, in ms. */
  readTimeoutMs: number;
};

/** slug → its app schema, because `appDbIdentifier` is one-way. */
async function schemasBySlug(store: BundleStore): Promise<Map<string, string>> {
  const bySchema = new Map<string, string>();
  for (const slug of await store.listSlugs()) {
    bySchema.set(appDbIdentifier(slug), slug);
  }
  return bySchema;
}

/** Is this app's hint due? See the savepoint note in the module doc. */
async function readOneHint(reserved: ReservedDb, schema: string): Promise<boolean> {
  await reserved.query("savepoint wake_read");
  try {
    const hint = await reserved.query<{ wake_at: unknown }>(dueHintSql(schema));
    await reserved.query("release savepoint wake_read");
    return hint[0]?.wake_at != null;
  } catch {
    debug("Workflow wake hint unreadable", { schema });
    await reserved.query("rollback to savepoint wake_read").catch(() => undefined);
    return false;
  }
}

/** The read phase's body, with the lock held. */
async function readDueLocked(reserved: ReservedDb, opts: ReadDueOptions): Promise<DueRead> {
  await reserved.query(`set local statement_timeout = ${opts.readTimeoutMs}`);
  const bySchema = await schemasBySlug(opts.store);
  const schemas = await reserved.query<{ table_schema: string }>(HINT_SCHEMAS_SQL, [
    WORKFLOW_WAKE_TABLE,
    [...bySchema.keys()],
  ]);

  const due: string[] = [];
  for (const row of schemas) {
    const schema = row.table_schema;
    const slug = bySchema.get(schema);
    // No slug means the agents table no longer lists it — the structural guard
    // against waking a deleted agent whose schema outlives its row.
    if (slug === undefined || !IDENTIFIER_RE.test(schema)) continue;
    if (await readOneHint(reserved, schema)) due.push(slug);
  }
  return { locked: true, candidates: schemas.length, due };
}

/**
 * Read every due hint, under the leader lock.
 *
 * ONE transaction on ONE reserved connection, for three reasons that happen to
 * coincide: the try-lock needs connection affinity, `set local` needs a
 * transaction, and the reads want a single snapshot. Booting happens after the
 * commit — a sandbox spawn must never hold a reserved admin connection.
 *
 * @internal
 */
export async function readDueWork(opts: ReadDueOptions): Promise<DueRead> {
  const reserved = await opts.adminDb.reserve();
  try {
    await reserved.query("begin");
    try {
      const lock = await reserved.query<{ locked: boolean }>(TRY_LOCK_SQL, [
        WORKFLOW_WAKE_NAMESPACE,
        WORKFLOW_WAKE_LOCK_KEY,
      ]);
      if (lock[0]?.locked !== true) return NOT_LOCKED;
      return await readDueLocked(reserved, opts);
    } finally {
      // Commit or rollback both release the lock and the `set local`; commit is
      // the honest one for a read-only transaction, and it is safe after an
      // aborted statement (Postgres turns it into a rollback).
      await reserved.query("commit").catch(() => undefined);
    }
  } finally {
    reserved.release();
  }
}
