// Copyright 2026 the AAI authors. MIT license.
/**
 * Apply this deployment's DDL so that concurrent boots SERIALIZE instead of
 * racing.
 *
 * `create table if not exists` is not safe to run concurrently: two sessions
 * that both find the table absent both try to create it, and one fails on the
 * catalog (`duplicate key value violates unique constraint
 * "pg_type_typname_nsp_index"`). Several processes booting on one database at
 * once is the ordinary shape — `aai start --workers`, or N containers behind a
 * load balancer — so the appliers run their batch inside ONE transaction that
 * first takes a transaction-scoped advisory lock. Whoever gets it first creates
 * the tables; the rest wait, then find them present.
 *
 * Transaction-scoped (`pg_advisory_xact_lock`) rather than session-scoped,
 * because a transaction-mode pooler (Supabase's Supavisor) does not keep a
 * session's server connection between transactions — a session lock taken
 * there could be released, or held, on a connection this process no longer
 * talks to.
 *
 * The `db` MUST have exactly one connection: `begin` and the statements after
 * it have to reach the same server session. The `ensure*Schema` wrappers own a
 * `max: 1` pool for exactly this; nothing that takes a caller's pool may call
 * this.
 *
 * @module
 */
import type { Db } from "@alexkroman1/aai/internal";

/** The one advisory-lock key every aai DDL batch takes, so they serialize with each other too. */
export const SCHEMA_LOCK_SQL = "select pg_advisory_xact_lock(hashtext('aai.schema-ddl'))";

/**
 * Run `apply` inside a transaction holding {@link SCHEMA_LOCK_SQL}. Commits when
 * it answers `true`, rolls back when it answers `false` or throws — a partial
 * batch never sticks. Answers what `apply` answered (`false` on a throw, which
 * is rethrown).
 */
export async function withSchemaLock(
  db: Pick<Db, "query">,
  apply: () => Promise<boolean>,
): Promise<boolean> {
  await db.query("begin");
  let committed = false;
  try {
    await db.query(SCHEMA_LOCK_SQL);
    const ok = await apply();
    if (ok) {
      await db.query("commit");
      committed = true;
    }
    return ok;
  } finally {
    if (!committed) await db.query("rollback").catch(() => undefined);
  }
}
