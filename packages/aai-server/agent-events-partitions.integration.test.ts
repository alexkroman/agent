// Copyright 2026 the AAI authors. MIT license.
/**
 * Does `aai-maintain-agent-events` survive a non-empty default partition?
 *
 * It did not, and the failure is the worst shape a maintenance job can take:
 * PERMANENT, SILENT, and reached by the ordinary path rather than an unusual
 * one.
 *
 * `create table … partition of …` must prove that no row in the default
 * belongs to the new bound, and Postgres RAISES rather than moving them
 * (`updated partition constraint for default partition "agent_events_default"
 * would be violated by some row`). That aborts the whole `do $$ … $$` block,
 * so partitions stop being created, retention stops dropping anything, and the
 * warning at the end — the one line that would have said "maintenance fell
 * behind" — is never reached. Every subsequent hourly run fails the same way.
 *
 * And the trigger is a fresh deployment, not an outage: the migration used to
 * ship only the default partition, ingest starts as soon as the deploy lands,
 * and the job runs at :34. Any row written in that gap poisons the table.
 *
 * **No unit test can see this.** The job is plpgsql, its failure lives in
 * Postgres's partition-constraint validation, and nothing in the repo models
 * partition routing — the same reason `jsonb-encoding.integration.test.ts`
 * exists one file over. So it needs a real database:
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
 *   pnpm --filter aai-server test:integration
 * ```
 *
 * Writes: it owns `aai_platform.agent_events` outright — it drops and rebuilds
 * the table from the migration in `beforeAll`. Do NOT point it at production.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { CloseableDb } from "@alexkroman1/aai/runtime";
import { createPostgresDb } from "@alexkroman1/aai/runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ANALYTICS_RETENTION_DAYS, PARTITION_LEAD_DAYS, platformCronJobs } from "./pg-cron.ts";

const PG_URL = process.env.AAI_TEST_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

/**
 * The job's command, read from the SAME array boot schedules — so this cannot
 * drift from what production runs, which is the only version worth testing.
 */
function maintenanceSql(): string {
  const job = platformCronJobs().find((j) => j.name === "aai-maintain-agent-events");
  if (!job) throw new Error("aai-maintain-agent-events is no longer declared");
  return job.command;
}

const MIGRATION = path.resolve(
  import.meta.dirname,
  "../../supabase/migrations/20260811000000_agent_events.sql",
);

describeIfPg("aai-maintain-agent-events against a real Postgres", () => {
  let db: CloseableDb;

  const partitions = async (): Promise<string[]> => {
    const rows = await db.query<{ relname: string }>(
      `select c.relname from pg_class c
         join pg_inherits i on i.inhrelid = c.oid
         join pg_class p on p.oid = i.inhparent
         join pg_namespace n on n.oid = p.relnamespace
        where n.nspname = 'aai_platform' and p.relname = 'agent_events'
        order by c.relname`,
    );
    return rows.map((r) => r.relname);
  };

  const count = async (table: string): Promise<number> => {
    const [row] = await db.query<{ n: string }>(`select count(*) as n from ${table}`);
    return Number(row?.n ?? 0);
  };

  /** One row through the PARENT, so partition routing decides where it lands. */
  const ingest = (): Promise<unknown> =>
    db.query(
      `insert into aai_platform.agent_events (slug, session_id, ts, kind)
       values ('demo', 's1', now(), 'user_turn')`,
    );

  beforeAll(async () => {
    db = createPostgresDb({ url: PG_URL as string });
    await db.query("create schema if not exists aai_platform");
  });

  beforeEach(async () => {
    // Rebuilt from the migration each time, so every case starts from the
    // shape a real deployment has rather than one the previous test left.
    await db.query("drop table if exists aai_platform.agent_events cascade");
    await db.query(readFileSync(MIGRATION, "utf-8"));
  });

  afterAll(async () => {
    await db?.query("drop table if exists aai_platform.agent_events cascade");
    await db?.close();
  });

  test("the migration leaves no window for the default to catch a row", async () => {
    // The original trigger: ingest begins the moment the deploy lands, and the
    // job does not run until :34. With only a default partition shipped, every
    // row in that gap poisoned the table.
    await ingest();
    expect(await count("aai_platform.agent_events_default")).toBe(0);
    expect(await count("aai_platform.agent_events")).toBe(1);
  });

  test("a non-empty default is DRAINED, not merely reported", async () => {
    // Reproduce the poisoned state exactly: with today's partition gone, the
    // insert has nowhere else to go.
    const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    await db.query(`drop table aai_platform.agent_events_${today}`);
    await ingest();
    expect(await count("aai_platform.agent_events_default")).toBe(1);

    await db.query(maintenanceSql());

    expect(await count("aai_platform.agent_events_default")).toBe(0);
    // Re-homed rather than discarded, and into its own day's partition.
    expect(await count("aai_platform.agent_events")).toBe(1);
    expect(await partitions()).toContain(`agent_events_${today}`);
    // Still the default, still attached — a drain that left the backstop
    // detached would turn the next gap into failing ingest.
    expect(await partitions()).toContain("agent_events_default");
  });

  test("the run that follows a drain is an ordinary no-op", async () => {
    const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    await db.query(`drop table aai_platform.agent_events_${today}`);
    await ingest();
    await db.query(maintenanceSql());
    const after = await partitions();

    await db.query(maintenanceSql());

    expect(await partitions()).toEqual(after);
    expect(await count("aai_platform.agent_events")).toBe(1);
  });

  test("rows older than retention are dropped by the drain rather than blocking it", async () => {
    // A row whose day is past retention has no partition to go back to and is
    // never getting one — the drain must not wedge on it.
    const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    await db.query(`drop table aai_platform.agent_events_${today}`);
    await ingest();
    // Written straight into the default: no partition covers that day, which
    // is exactly why it is stuck there.
    await db.query(
      `insert into aai_platform.agent_events_default (slug, session_id, ts, kind, received_at)
       values ('demo', 'old', now(), 'user_turn', now() - interval '${ANALYTICS_RETENTION_DAYS + 30} days')`,
    );

    await db.query(maintenanceSql());

    expect(await count("aai_platform.agent_events_default")).toBe(0);
    // The recent row survived; the expired one did not.
    expect(await count("aai_platform.agent_events")).toBe(1);
  });

  test("retention drops a wholly expired partition and keeps a live one", async () => {
    await db.query(
      `create table aai_platform.agent_events_20200101 partition of aai_platform.agent_events
         for values from ('2020-01-01') to ('2020-01-02')`,
    );
    await ingest();

    await db.query(maintenanceSql());

    const after = await partitions();
    expect(after).not.toContain("agent_events_20200101");
    expect(await count("aai_platform.agent_events")).toBe(1);
  });

  test("partitions are created across the whole retention window, not just ahead", async () => {
    // The trailing half is what gives a drained row a home. Without it the
    // drain would discard rows still inside retention, which is a data loss
    // wearing a maintenance job's clothes.
    await db.query(maintenanceSql());
    const days = (await partitions()).filter((n) => /^agent_events_\d{8}$/.test(n));
    expect(days.length).toBe(ANALYTICS_RETENTION_DAYS + PARTITION_LEAD_DAYS + 1);
  });
});
