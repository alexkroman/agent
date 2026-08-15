// Copyright 2026 the AAI authors. MIT license.
/**
 * The pg_cron sweep for session state whose guest is GONE.
 *
 * Its own module because the SQL is a plpgsql block over every app schema and
 * `pg-cron.ts` is already at the length where one more of those hurts; that file
 * declares the job, this one holds the statement and the argument for it.
 *
 * ## What it is for
 *
 * A session's slot state is durable now (`aai/host/session-state-store.ts`), so
 * a crash or a redeploy no longer costs a caller their cart. The guest reclaims
 * its own rows after the resume grace window
 * (`aai/host/session-state-sweeps.ts`) — and by construction it cannot reclaim
 * the case durability exists for: an agent guest SELF-EXITS on idle, so rows
 * belonging to a session nobody resumed are left behind by a process that is no
 * longer running. Exactly the gap `workflow-wake.ts` was built for, stated there
 * as "a durable run outlives the call that started it, and on the platform the
 * SANDBOX does not."
 *
 * The retention window is far above the guest's own
 * {@link SESSION_RESUME_GRACE_MS} (120 s), because this is the backstop for a
 * dead guest rather than a second opinion about a live one — and a row deleted
 * while a caller was still reconnecting is the one failure worth avoiding, being
 * indistinguishable to them from the loss the whole mechanism removes.
 *
 * ## Why a cron job rather than the wake sweep's cross-tenant reader
 *
 * `_workflow-wake-read.ts` already walks every app schema with three hazards
 * solved — a transaction-scoped leader lock, `set local` for the statement
 * timeout, and a SAVEPOINT per tenant so one broken schema cannot deny every
 * later one — and reusing it was the obvious move. It buys nothing here, on
 * three counts. That pass runs on the platform's admin connection, which reaches
 * the same one cluster this job does. It is READ-ONLY under a leader lock on the
 * request-serving process, and a DELETE does not belong inside it. And a sweep
 * that needs no replica running at all is strictly more reliable than one that
 * does.
 *
 * What IS shared is the part that can disagree: the table name is the SDK
 * constant both ends derive from, and the identifier assertion is the same
 * `^app_[a-f0-9]{16}$` shape every other statement in `pg-cron.ts` re-asserts.
 *
 * ## The limitation, stated because its siblings state theirs
 *
 * **Apps placed on an extra `APP_DB_URLS` cluster are not swept.** pg_cron runs
 * on the platform database and those clusters have no local schema — the same
 * note the orphan-preview sweep and the wake sweep both carry. Their rows are
 * reclaimed by the guest's own grace sweep whenever a guest is alive to run it,
 * and otherwise accumulate: bounded per session by `MAX_SESSION_STATE_BYTES`,
 * and visible to the author as their own database usage (`appDatabaseUsage`
 * counts every base table in the app schema), which is the pressure that would
 * make a per-cluster executor worth writing.
 */

import { SESSION_STATE_TABLE } from "@alexkroman1/aai/runtime";

/**
 * How long a row outlives the last write to it.
 *
 * Two days rather than hours: the cost of keeping one is a few KB in the
 * tenant's own schema, and the cost of dropping one early is a caller who
 * reconnects to an agent that has forgotten them — which is the failure this
 * whole path exists to remove, arriving by a new route.
 */
const RETENTION = "2 days";

/**
 * One delete per app schema that has the table, each in its own plpgsql block.
 *
 * The per-tenant `begin ... exception` is this file's equivalent of the wake
 * read's SAVEPOINT, and for the same reason: the table is TENANT-OWNED, so a
 * schema whose copy was reshaped, locked or dropped must cost only itself. The
 * `~ '^app_...'` filter in the cursor and `format(%I)` in the execute are the
 * two halves of the identifier rule — a schema name is never interpolated raw,
 * and only the provisioned shape is ever considered.
 *
 * @internal
 */
export const SWEEP_SESSION_STATE = `do $$
declare
  target record;
begin
  for target in
    select table_schema from information_schema.tables
    where table_name = '${SESSION_STATE_TABLE}'
      and table_type = 'BASE TABLE'
      and table_schema ~ '^app_[a-f0-9]{16}$'
  loop
    begin
      execute format(
        'delete from %I.%I where updated_at < now() - interval ''${RETENTION}''',
        target.table_schema, '${SESSION_STATE_TABLE}');
    exception when others then
      raise warning 'session-state sweep: % failed: %', target.table_schema, sqlerrm;
    end;
  end loop;
end $$`;
