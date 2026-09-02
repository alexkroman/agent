// Copyright 2026 the AAI authors. MIT license.
/**
 * The two SLEEP statements, on the platform's own database.
 *
 * Split from `platform-workflow-journal.ts` at the seam that file already used
 * for the hooks: one table, its own module, re-exported so a caller still sees
 * one journal. It moved when `started_at` pushed that file past the 500-line
 * cap, and the sleeps are the family with the fewest ties to the rest: the run,
 * step and attempt statements share `TERMINAL`, `toRun`/`toStep` and the release
 * CTE, and NOTHING there reaches this table — where the hooks had to be imported
 * back for that CTE.
 *
 * Every property that file states holds here: the slug is `$1` of every
 * statement and comes from the bearer, and no statement binds a bare `$n::jsonb`.
 *
 * @internal
 */

import type { SqlExec } from "./secret-store.ts";

/**
 * The sleep table.
 *
 * Exported because `platform-workflow-journal.ts` re-exports it, so a caller
 * still finds every table name on one module — not because anything there
 * reaches it. `HOOKS` next door IS reached, by `setStatus`'s release CTE.
 *
 * @internal
 */
export const SLEEPS = "aai_platform.workflow_sleeps";

/** One wait. */
export type JournalSleepRow = {
  wakeAt: number;
  woken: boolean;
  correlationId: string | undefined;
  kind: string;
};

/** `bigint` arrives as a STRING from the driver, and `Number` is the read. */
const millis = (value: unknown): number => Number(value);

/** A stored value, as the codec wrote it. `null` from the driver means absent. */
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Record a wait, or read the one already recorded.
 *
 * First write wins and later calls are READS — which is what stops a replay
 * pushing the deadline further out on every walk of the body.
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
  await sql(
    `insert into ${SLEEPS} (slug, run_id, key, wake_at, correlation_id, kind)
     values ($1, $2, $3, $4, $5, $6) on conflict (slug, run_id, key) do nothing`,
    [slug, runId, key, wakeAt, correlationId ?? null, kind],
  );
  const rows = await sql(
    `select wake_at, woken, correlation_id, kind from ${SLEEPS}
      where slug = $1 and run_id = $2 and key = $3`,
    [slug, runId, key],
  );
  const row = rows[0];
  if (!row) throw new Error(`workflow sleep ${key} vanished for run ${runId}`);
  return {
    wakeAt: millis(row.wake_at),
    woken: Boolean(row.woken),
    correlationId: text(row.correlation_id),
    kind: String(row.kind),
  };
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
