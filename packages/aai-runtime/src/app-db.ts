// Copyright 2026 the AAI authors. MIT license.
/**
 * ONE Postgres pool per app database per PROCESS, leased to every consumer that
 * wants one.
 *
 * Four things in a deployed guest talk to the app's own database with the app's
 * own credentials: `ctx.db` (the runtime), the session-state backend, the
 * workflow upload store, and the wake-hint publisher. They are the same role on
 * the same URL, they run the same short statements, and none of them holds
 * session state between statements — so there was never a reason for them to be
 * four pools, and there is a hard reason for them not to be: the role's
 * `connection limit`. Four pools meant four CEILINGS summed into the budget
 * (`sdk/app-db-budget.ts` has the arithmetic and the failure it produced), where
 * one pool means one.
 *
 * ## Why a lease rather than a handle
 *
 * Because "what this call opened is what it closes" is the ownership rule every
 * caller here already follows — `runtime.ts` closes the `ctx.db` it opened so a
 * rebuilt `aai dev` runtime does not strand a pool, and `installWorkflowSupport`
 * closes the upload pool for the same reason. A shared handle with a plain
 * `close()` would break that rule in the worst direction: the first caller to
 * dispose would close the pool the others are still using. So {@link openAppDb}
 * hands out a LEASE — a `CloseableDb` that delegates every query to the shared
 * pool and whose `close()` releases only this lease. The pool closes when the
 * last one does, which makes each caller's existing `close()` correct as
 * written.
 *
 * ## Why the registry lives on `globalThis`
 *
 * The same reason the step slots do (`sdk/step-uploads.ts`): a deployed agent's
 * bundle carries its OWN copy of this SDK, so the runtime's `createRuntime` and
 * the harness's `createServer` are two module instances in one realm. A
 * module-level `Map` would be two maps and two pools. A `Symbol.for` key is one
 * registry for the process, whichever copy asks.
 *
 * That also bounds what this can fix: a guest whose bundle predates this module
 * opens its own `ctx.db` pool, and its footprint is the old one. The degrade is
 * the failure this exists to prevent, reported by whichever consumer asks for
 * the connection that is not there — never silent.
 */

import { APP_DB_POOL_MAX } from "@alexkroman1/aai/host-internal";
import { type CloseableDb, createPostgresDb } from "./postgres-db.ts";

/** The registry-wide slot — see the module doc for why it is not a module-level `Map`. */
const APP_DB_POOLS = Symbol.for("@alexkroman1/aai.appDbPools");

/** One pool and the number of live leases on it. */
type PoolEntry = { db: CloseableDb; leases: number };

/** The shape stored in the slot. */
type PoolRegistry = { [APP_DB_POOLS]?: Map<string, PoolEntry> };

function registry(): Map<string, PoolEntry> {
  const host = globalThis as PoolRegistry;
  const existing = host[APP_DB_POOLS];
  if (existing) return existing;
  const created = new Map<string, PoolEntry>();
  host[APP_DB_POOLS] = created;
  return created;
}

/**
 * Take a lease on this process's pool for `url`, opening it if this is the first.
 *
 * The pool is sized at {@link APP_DB_POOL_MAX} — the app role's whole share for
 * everything that is not the DevKit's world — and connections open lazily, so a
 * lease costs nothing until something queries.
 *
 * Close the lease when you are done with it, exactly as you would a handle of
 * your own; the pool outlives it if anybody else still holds one.
 *
 * @internal
 */
export function openAppDb(url: string): CloseableDb {
  const pools = registry();
  const entry: PoolEntry = pools.get(url) ?? {
    db: createPostgresDb({ url, max: APP_DB_POOL_MAX }),
    leases: 0,
  };
  entry.leases += 1;
  pools.set(url, entry);
  let released = false;
  // Every mutation below this line is SYNCHRONOUS — the lease count moves and the
  // registry entry is dropped in the same tick, with the pool's `close()` awaited
  // only afterwards. So an entry in the registry always has at least one live
  // lease, and the entry present when a count reaches zero is always this one:
  // the `if (map.get(k) === mine)` guard that a late async teardown needs
  // (`guard-invariants` rule 8, `createOwnedMap`) has nothing to guard against
  // here. Adding an await between the decrement and the delete would change that.
  return {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      return entry.db.query<T>(sql, params);
    },
    reserve: () => entry.db.reserve(),
    // Delegated for completeness rather than because anything here uses it: a
    // shared-pool lease is the wrong owner for a dedicated listening connection,
    // so a caller wanting one on an author's database should say so explicitly.
    // Left rather than thrown so the handle stays a `CloseableDb`.
    listen: (channel, onNotify) => entry.db.listen(channel, onNotify),
    async close(): Promise<void> {
      // Idempotent, because every caller's own `close()` is: a double release
      // would drop the pool out from under a lease somebody else still holds.
      if (released) return;
      released = true;
      entry.leases -= 1;
      if (entry.leases > 0) return;
      // Dropped from the registry BEFORE the await, so a lease taken while the
      // pool is draining gets a new pool rather than a closing one.
      pools.delete(url);
      await entry.db.close();
    },
  };
}
