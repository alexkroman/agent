// Copyright 2026 the AAI authors. MIT license.
/**
 * How much is in one app's database — the number the studio shows an author as
 * their own usage.
 *
 * Its own module, split from `app-database.ts` at the file-length cap, and the
 * seam is real: everything there provisions or drops, and this only READS. It is
 * also the one query here whose SHAPE is an argument rather than a mechanism —
 * both of its choices are counter-intuitive and both are load-bearing, so they are
 * stated on the function.
 *
 * It runs on a connection INTO the app's database, because `information_schema` is
 * per-database; `AppDatabases.usage` opens and closes one per call.
 */

import type { SqlExec } from "./secret-store.ts";

/** What one app's database holds right now. */
export type AppDbUsage = {
  tables: number;
  /** Summed across every table in the app's own schemas. */
  rows: number;
  /** Bytes, including indexes and TOAST (`pg_total_relation_size`). */
  bytes: number;
};

/**
 * How much is actually in one app's database.
 *
 * **Row counts are EXACT, not `reltuples`.** The planner's estimate is the
 * usual answer to "how big is this table", and it is the wrong one here: it
 * is `-1` until the first `ANALYZE` and stale after every write until
 * autovacuum catches up — so a freshly written row reads as zero, which is
 * precisely the question this exists to answer ("is my agent saving
 * anything?"). Counting is affordable because these are per-agent databases
 * holding a tool's state, and the count is bounded regardless: it runs with a
 * statement timeout, and a database is skipped rather than failing the read
 * (see the caller).
 *
 * **Bytes are the app's own RELATIONS, deliberately not `pg_database_size`.**
 * That function is one cheap call on the admin connection and would be the
 * obvious choice, but a freshly created database already measures ~7.5 MB of
 * inherited template catalog — so every empty app would report 7.5 MB to its
 * author, in the studio, as their own usage. Summing relations keeps an empty
 * app at zero, which is the only honest answer.
 *
 * One statement rather than one per table: `query_to_xml` runs the count for
 * each table inside the same round trip, which is the standard trick for
 * exact counts across a schema and keeps this off the N+1 path.
 */
export async function appDatabaseUsage(sql: SqlExec): Promise<AppDbUsage> {
  const rows = await sql(
    `select
       count(*)::int8 as tables,
       coalesce(sum((xpath('/row/c/text()',
         query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name),
                      false, true, '')))[1]::text::int8), 0) as rows,
       coalesce(sum(pg_total_relation_size(format('%I.%I', table_schema, table_name)::regclass)), 0)
         as bytes
     from information_schema.tables
     where table_type = 'BASE TABLE'
       and table_schema not in ('pg_catalog', 'information_schema')`,
  );
  const row = rows[0] ?? {};
  // Postgres returns int8 as a string in most drivers; Number is safe at
  // these magnitudes and a NaN would be a lie, so it degrades to 0.
  const num = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return { tables: num(row.tables), rows: num(row.rows), bytes: num(row.bytes) };
}
