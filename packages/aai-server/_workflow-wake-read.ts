// Copyright 2026 the AAI authors. MIT license.
/**
 * The READ half of the durable-run wake sweep: which agents have work due right
 * now, according to the hints their guests published.
 *
 * Split from `workflow-wake.ts` — which owns the POLICY (what to do about a due
 * agent: the backoff, the per-tick cap, the interval) — along the seam the two
 * halves already had: this file decides nothing. Read `workflow-wake.ts` first;
 * its module doc carries the design, the cost, and why the platform reads a
 * guest-published hint instead of the DevKit's queue.
 *
 * ── WHY THIS IS NO LONGER ONE TRANSACTION ────────────────────────────────────
 *
 * Each app's hint lives in the app's own DATABASE now (see `app-database.ts` for
 * why a schema could not host the Workflow DevKit at all). A Postgres connection
 * is bound to one database, so the platform's admin connection cannot read a
 * tenant's table however it is qualified — the pass is therefore a leader lock on
 * the admin connection plus one short-lived connection per candidate app.
 *
 * Two properties of the old shape survive, and one dissolves:
 *
 * - **The leader lock is still TRANSACTION-scoped** (`pg_try_advisory_xact_lock`)
 *   and still on a reserved connection, because a try-lock needs affinity and a
 *   session-scoped lock leaked onto a pooled connection by a pass that threw is
 *   exactly the hazard `platform-lock.ts` guards against. It is HELD across the
 *   per-app reads: the transaction stays open until the pass finishes, so a
 *   second replica cannot duplicate the work rather than merely losing a race at
 *   the end of it.
 * - **The statement timeout is still bounded**, but now per connection: `set
 *   local` on the admin transaction bounds the metadata read, and each app
 *   connection sets its own before reading. A tenant table that has grown huge
 *   bounds itself and nothing else.
 * - **The SAVEPOINTS are GONE, and their reason with them.** They existed because
 *   a failed read of a tenant-owned table aborts the whole transaction, so the
 *   first broken tenant used to cost every later tenant its wake in the same pass
 *   — a cross-tenant denial of the only mechanism a parked run has. A per-app
 *   connection cannot do that: a read that throws takes down a connection nothing
 *   else is using. The isolation is now structural rather than bookkept.
 *
 * **Reads fan out to a CONSTANT width, and the constant is the whole point.**
 * Each one opens a real connection (`APP_DB_ADMIN_POOL_MAX` is 1), and the
 * fleet-wide direct-connection budget is the scarce thing here —
 * `MAX_PLATFORM_DB_CONNECTIONS` cannot bound a number that scales with the app
 * count. So the width is `WORKFLOW_WAKE_READ_CONCURRENCY`, held by a worker pool
 * (see {@link readHints} for why a semaphore is the wrong primitive here): the
 * pass costs K extra connections regardless of how many apps exist, which keeps the budget independent of the app count exactly as a serial
 * loop did, and takes the pass duration to 1/K of it.
 *
 * It WAS serial, argued as "at the cost of latency inside a 60s interval that has
 * room for it". The interval has room for a fixed cost, not for a linear one:
 * per-app connect plus two or three statements is tens of seconds at a few
 * hundred apps, and `readTimeoutMs` is per app, so a handful of tenants with a
 * bloated hint table add five seconds each to the same pass. What made that worse
 * than slow is that the whole pass runs inside the leader transaction — so it is
 * also a reserved admin connection and an advisory lock held that long — and that
 * `start()` skips a tick while one is running, so overrunning the interval halves
 * the sweep rate of the only mechanism that wakes a run nobody is delivering to.
 * K is a declared bound where serial was a property of the loop shape; see the
 * constant's own doc for why it is four.
 *
 * **The candidate filter changed shape too.** It used to be one catalog query on
 * the admin connection naming every app schema that had a hint table, so an app
 * with storage and no workflows cost nothing. `information_schema` is
 * per-database, so that answer is only available inside each app's own database.
 * The cheap filter that replaces it is the `app-db:` credential itself: an app
 * with no provisioned database cannot have published a hint, and those metas come
 * back in ONE query over the same Vault view `pg-cron.ts` reads. An app with
 * storage but no workflows now costs a connection and two statements per tick,
 * which is the price of the DevKit working at all.
 */

import { type ReservedDb, WORKFLOW_WAKE_TABLE } from "@alexkroman1/aai-runtime";
import {
  APP_DB_SCHEMA,
  type AppDatabases,
  type AppDbMeta,
  appDbIdentifier,
  parseAppDbMeta,
} from "./app-database.ts";
import { envCount } from "./constants.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import { APP_DB_SECRET_PREFIX, type SqlExec } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";

const log = createLogger("workflow.wake");

/**
 * How many app databases the read phase opens AT ONCE.
 *
 * Here rather than in `constants.ts` because it is this concern's number and that
 * file is at its line cap — the placement rule `LOGS_READY_TIMEOUT_MS` follows.
 * `APP_DB_ADMIN_POOL_MAX`'s doc CITES it, though, because it is what makes the
 * platform's transient app-database connections a constant rather than a function
 * of the app count, which is the premise on which they are left out of
 * `platformDbConnectionsPerReplica`.
 *
 * Four. K-wide costs K transient connections instead of 1 — still a CONSTANT,
 * which is the whole property, since the app count is the one variable
 * `MAX_PLATFORM_DB_CONNECTIONS` cannot bound — for 1/K of the duration.
 * Fleet-wide K, not per-replica: the pass holds a transaction-scoped advisory
 * lock, so one replica sweeps per tick. Against the ~20 connections that budget
 * leaves the rest of the instance, four is comfortable and forty is not.
 *
 * Override with `WORKFLOW_WAKE_READ_CONCURRENCY`; 1 restores the serial pass.
 */
export const WORKFLOW_WAKE_READ_CONCURRENCY = envCount(
  process.env.WORKFLOW_WAKE_READ_CONCURRENCY,
  4,
);

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
 * Every provisioned app's stored credential, in one query.
 *
 * Read straight off the Vault view rather than through `SecretStore.get` per
 * slug, which would be one admin query per agent per tick where this is one for
 * the fleet. That is the same view and the same prefix `pg-cron.ts`'s sweeps
 * read, and the prefix is BOUND rather than interpolated — `app-db:` carries no
 * LIKE wildcard today and a constant that grew one would silently widen the
 * match.
 *
 * Guarded on Vault existing at all: it belongs to Supabase and a platform
 * database without it should read as "no apps have databases" rather than
 * failing the pass.
 */
const APP_DB_METAS_SQL = `select name, decrypted_secret
from vault.decrypted_secrets
where name like $1`;

const VAULT_PRESENT_SQL = "select to_regclass('vault.secrets') is not null as present";

/**
 * Is this app's hint due?
 *
 * Two statements rather than one, because Postgres plans a whole statement: a
 * `case when to_regclass(...) is null` wrapping the read still fails to plan
 * when the table is absent, so the existence check cannot be folded in. That
 * check is also what makes `candidates` mean what it meant before — an app that
 * has a database but runs no workflows has no hint table.
 *
 * `min` and `where wake_at <= now()` are both deliberate. The filter runs in the
 * DATABASE so the comparison uses the same clock the guest wrote against — a
 * replica's clock skew must not decide whether a run resumes — and a null result
 * then means "not due" with no second interpretation. `min` rather than `max`
 * errs toward waking: the table holds one row by construction, and if a tenant
 * made it hold more, the earliest is the reading that cannot strand a run.
 */
const HINT_PRESENT_SQL = `select to_regclass('${APP_DB_SCHEMA}.${WORKFLOW_WAKE_TABLE}') is not null as present`;
const DUE_HINT_SQL = `select min(wake_at) as wake_at
from ${APP_DB_SCHEMA}.${WORKFLOW_WAKE_TABLE}
where wake_at <= now()`;

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
  /** Opens a connection into one app's own database. */
  appDb: AppDatabases;
  /** `set local statement_timeout` for the pass, in ms. */
  readTimeoutMs: number;
  /**
   * How many app databases may be read at once — see
   * `WORKFLOW_WAKE_READ_CONCURRENCY` in `constants.ts`. Passed rather than read from the
   * constant here so a spec can pin the width it is asserting on; the sweep
   * supplies the default.
   */
  readConcurrency: number;
};

/**
 * slug → its stored app-db meta, for every slug the agents table still lists.
 *
 * The intersection is the structural guard against waking a DELETED agent: a
 * deprovision drops the database, but a partially failed one can leave a
 * credential behind, and a slug the agents table no longer names must never be
 * booted.
 */
async function metasBySlug(sql: SqlExec, store: BundleStore): Promise<Map<string, AppDbMeta>> {
  const vault = await sql(VAULT_PRESENT_SQL);
  if (vault[0]?.present !== true) return new Map();

  const rows = await sql(APP_DB_METAS_SQL, [`${APP_DB_SECRET_PREFIX}%`]);
  const byName = new Map<string, AppDbMeta>();
  for (const row of rows) {
    const name = row.name;
    const raw = row.decrypted_secret;
    if (typeof name !== "string" || typeof raw !== "string") continue;
    const meta = parseAppDbMeta(raw);
    if (meta !== null) byName.set(name, meta);
  }

  const bySlug = new Map<string, AppDbMeta>();
  for (const slug of await store.listSlugs()) {
    const meta = byName.get(`${APP_DB_SECRET_PREFIX}${slug}`);
    // The identifier is re-derived and compared rather than trusted: a stored
    // meta is data, and its `role` is what names the database we connect to.
    if (meta !== undefined && meta.role === appDbIdentifier(slug)) bySlug.set(slug, meta);
  }
  return bySlug;
}

/**
 * Read one app's hint on a connection into its own database.
 *
 * Resolves `null` for every "no" — no hint table, nothing due, or a read that
 * failed — because the caller does the same thing with all three and a thrown
 * error here would end the whole pass. A failure is DEBUG-logged rather than
 * warned: a tenant may legitimately drop its own table.
 */
async function readOneHint(
  appDb: AppDatabases,
  slug: string,
  meta: AppDbMeta,
  readTimeoutMs: number,
): Promise<{ present: boolean; due: boolean }> {
  try {
    return await appDb.withAppDb(meta, async (sql) => {
      // A plain `set`, not `set local`: this connection is closed when the
      // callback settles, so there is no transaction to scope it to and no
      // pooled connection for it to ride back on.
      await sql(`set statement_timeout = ${readTimeoutMs}`);
      const present = await sql(HINT_PRESENT_SQL);
      if (present[0]?.present !== true) return { present: false, due: false };
      const hint = await sql(DUE_HINT_SQL);
      return { present: true, due: hint[0]?.wake_at != null };
    });
  } catch {
    log.debug("Workflow wake hint unreadable", { slug });
    return { present: false, due: false };
  }
}

/**
 * Read every candidate's hint, at most `WORKFLOW_WAKE_READ_CONCURRENCY` at a
 * time, answering in the order they were given.
 *
 * **A worker pool, and NOT `_semaphore.ts`, because every candidate would have to
 * ask for its slot at once.** That primitive's wait is bounded by design — right
 * for a request path, wrong here, and wrong in a way that is invisible until the
 * app count grows. The deadline would run from the moment `acquire` is called,
 * which for a `map` over the candidates is t=0 for all of them: with K=4, reads
 * of ~100ms and a 5s deadline, everything past roughly the two-hundredth app
 * lapses on EVERY tick and is reported "not due" without ever being read. That is
 * strictly worse than the serial loop this replaced, which was slow but did
 * eventually read every app. Workers pulling from a cursor have no such deadline:
 * an app's wait is bounded by the work ahead of it, and every app is read.
 *
 * `readTimeoutMs` is still a bound, in the place it belongs — the `statement_timeout`
 * inside {@link readOneHint}, which is what stops one tenant's bloated table
 * costing the pass more than one read's worth of time.
 */
async function readHints(
  opts: ReadDueOptions,
  candidates: [slug: string, meta: AppDbMeta][],
): Promise<{ slug: string; present: boolean; due: boolean }[]> {
  const hints: { slug: string; present: boolean; due: boolean }[] = [];
  let next = 0;
  const drain = async (): Promise<void> => {
    // Read the entry and test IT rather than the index, so the cursor needs no
    // cast under `noUncheckedIndexedAccess`. `at` is captured before the await,
    // so each result lands at its OWN index — `due`'s order is the slug order the
    // per-tick cap depends on, never completion order.
    for (let at = next++, entry = candidates[at]; entry; at = next++, entry = candidates[at]) {
      const [slug, meta] = entry;
      hints[at] = { slug, ...(await readOneHint(opts.appDb, slug, meta, opts.readTimeoutMs)) };
    }
  };
  const workers = Math.min(Math.max(1, Math.round(opts.readConcurrency)), candidates.length);
  await Promise.all(Array.from({ length: workers }, drain));
  return hints;
}

/** The read phase's body, with the leader lock held. */
async function readDueLocked(reserved: ReservedDb, opts: ReadDueOptions): Promise<DueRead> {
  await reserved.query(`set local statement_timeout = ${opts.readTimeoutMs}`);
  const metas = await metasBySlug((query, params) => reserved.query(query, params), opts.store);

  // Fanned out to a constant width — see the module doc on why the width is a
  // constant and not the app count. Mapped over an ARRAY and reduced in index
  // order, never appended to from inside the tasks, because `due`'s ORDER is
  // load-bearing: the wake loop's per-tick cap takes the first N, and
  // `workflow-wake.ts` rests on that order being the slug order so the cap
  // cannot starve one agent forever. Completion order is whatever the databases
  // answer in, which is neither stable nor the slug order.
  const hints = await readHints(opts, [...metas]);
  const due: string[] = [];
  let candidates = 0;
  for (const hint of hints) {
    if (hint.present) candidates += 1;
    if (hint.due) due.push(hint.slug);
  }
  return { locked: true, candidates, due };
}

/**
 * Read every due hint, under the leader lock.
 *
 * The lock is held for the whole pass — including the per-app connections — so a
 * second replica cannot duplicate the reads. Booting still happens after the
 * commit: a sandbox spawn must never hold a reserved admin connection.
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
