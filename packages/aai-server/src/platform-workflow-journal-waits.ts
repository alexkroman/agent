// Copyright 2026 the AAI authors. MIT license.
/**
 * A run's durable WAITS, on the platform's own database.
 *
 * Split from `platform-workflow-journal.ts` at the seam
 * `platform-workflow-journal-hooks.ts` already drew, and for the same mechanical
 * reason its header gives: five hundred lines is the cap, and the sleep table is
 * a self-contained subject. Every property that file states holds here too — the
 * slug is `$1` of every statement and comes from the BEARER, never from the
 * request — and `platform-workflow-journal.ts` re-exports all of it, so a caller
 * still sees one journal.
 *
 * The three together are the whole of the table's contract: {@link claimSleep}
 * decides a deadline ONCE, {@link wakeSleeps} cuts short what a wake reaches, and
 * {@link readSleeps} hands a replay the whole set in one round trip so it does
 * not re-claim every finished wait it walks past. That last one is the newest and
 * it is a PERFORMANCE contract rather than a correctness one — see
 * `JournalStore.readSleeps` in `aai-runtime` for the production measurement that
 * motivated it.
 *
 * @internal
 */

import { firstWriteWins } from "@alexkroman1/aai-runtime/internal";
import type { JournalSleepRow } from "./platform-workflow-journal-rows.ts";
import { millis, text } from "./platform-workflow-journal-rows.ts";
import type { SqlExec } from "./secret-store.ts";

/**
 * The sleep table.
 *
 * Exported because `resumableRuns`-shaped questions elsewhere on the platform
 * (`workflow-queue-reconcile.ts`) reach it, and the two must name one table.
 *
 * @internal
 */
export const SLEEPS = "aai_platform.workflow_sleeps";

/** One wait, from the claim's `returning` and from the bulk read alike. */
function toSleep(row: Record<string, unknown>): JournalSleepRow {
  return {
    wakeAt: millis(row.wake_at),
    woken: Boolean(row.woken),
    correlationId: text(row.correlation_id),
    kind: String(row.kind),
  };
}

/**
 * Record a wait, or read the one already recorded.
 *
 * First write wins and later calls are READS — which is what stops a replay
 * pushing the deadline further out on every walk of the body. ONE statement,
 * re-run while the answer is indeterminate: {@link firstWriteWins}.
 */
export async function claimSleep(
  sql: SqlExec,
  slug: string,
  runId: string,
  key: string,
  wakeAt: number,
  correlationId: string | undefined,
  kind: string,
): Promise<JournalSleepRow> {
  return await firstWriteWins(
    async () => {
      const rows = await sql(
        `with mine as (
           insert into ${SLEEPS} (slug, run_id, key, wake_at, correlation_id, kind)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (slug, run_id, key) do nothing
           returning wake_at, woken, correlation_id, kind
         )
         select wake_at, woken, correlation_id, kind from mine
         union all
         select wake_at, woken, correlation_id, kind from ${SLEEPS}
          where slug = $1 and run_id = $2 and key = $3`,
        [slug, runId, key, wakeAt, correlationId ?? null, kind],
      );
      const row = rows[0];
      return row ? toSleep(row) : undefined;
    },
    () => `workflow sleep ${key} vanished for run ${runId}`,
  );
}

/**
 * Every wait this run has registered, ordered by `key`.
 *
 * One read per WALK, which is what it replaced: a replay reaches every sleep the
 * body has ever taken, and each of those used to be its own `claimSleep` round
 * trip against this route even though the wait had finished deliveries ago. A
 * polling body made that quadratic — see `JournalStore.readSleeps`.
 *
 * `order by key` because the interface promises it, and it is free: the table's
 * primary key is `(slug, run_id, key)`, so this is a range scan already in that
 * order. `key` is SELECTED here and not by {@link claimSleep}, whose caller knows
 * which key it asked about.
 */
export async function readSleeps(
  sql: SqlExec,
  slug: string,
  runId: string,
): Promise<(JournalSleepRow & { key: string })[]> {
  const rows = await sql(
    `select key, wake_at, woken, correlation_id, kind from ${SLEEPS}
      where slug = $1 and run_id = $2 order by key`,
    [slug, runId],
  );
  return rows.map((row) => ({ ...toSleep(row), key: String(row.key) }));
}

/**
 * Cut short every wait this call reaches, and answer how many.
 *
 * Three refusals as one `where`, the same three the memory backend makes: an
 * ELAPSED wait is not one this call stopped, nor is an already-woken one, and a
 * BARE wake reaches ordinary sleeps only — so cutting a schedule short cannot
 * also close an approval window.
 */
export async function wakeSleeps(
  sql: SqlExec,
  slug: string,
  runId: string,
  now: number,
  correlationIds: readonly string[] | undefined,
): Promise<number> {
  const rows = await sql(
    `update ${SLEEPS}
        set woken = true
      where slug = $1 and run_id = $2
        and woken = false
        and wake_at > $3
        and case
              when $4::text[] is null then kind = 'sleep'
              else correlation_id = any($4::text[])
            end
      returning key`,
    [slug, runId, now, correlationIds ?? null],
  );
  return rows.length;
}
