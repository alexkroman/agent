// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the wake hint.
 *
 * Against a recording `Db`, because what can go wrong in this module is the
 * SHAPE of the work: publishing at all when there is no queue, forgetting a
 * failed DDL, letting a bookkeeping fault reject into a queue callback, or
 * counting a permanently-failed job as claimable. The last of those is the one
 * claim a fake cannot check — whether the SQL really excludes it — so it is
 * asserted against a real Postgres in
 * `aai-server/workflow-wake.scenario.test.ts`, which owns both ends of this
 * contract.
 */

import { describe, expect, test, vi } from "vitest";
import type { Db } from "../sdk/db.ts";
import { silentLogger } from "./_test-utils.ts";
import {
  createWakeHintPublisher,
  GRAPHILE_JOB_EXPIRY,
  WORKFLOW_WAKE_TABLE,
} from "./workflow-wake-hint.ts";

/** A `Db` recording every statement, answering the queue probe as told. */
function recordingDb(opts: { queuePresent?: boolean; fail?: RegExp } = {}): Db & {
  sql: string[];
} {
  const sql: string[] = [];
  return {
    sql,
    query: vi.fn(async (statement: string) => {
      sql.push(statement);
      if (opts.fail?.test(statement)) throw new Error("boom");
      if (statement.includes("to_regclass")) {
        return [{ present: opts.queuePresent ?? true }] as never;
      }
      return [] as never;
    }),
  };
}

/** Statements matching `re`, for asserting what a publish actually issued. */
function matching(db: { sql: string[] }, re: RegExp): string[] {
  return db.sql.filter((statement) => re.test(statement));
}

describe("createWakeHintPublisher", () => {
  test("is inert with no database, rather than deciding what to do without one", async () => {
    const publisher = createWakeHintPublisher();
    await expect(publisher.publish()).resolves.toBeUndefined();
    await expect(publisher.close()).resolves.toBeUndefined();
  });

  test("creates the table and upserts the one row", async () => {
    const db = recordingDb();
    await createWakeHintPublisher({ db, intervalMs: 0 }).publish();

    expect(matching(db, /create table if not exists/)).toHaveLength(1);
    const upsert = matching(db, /^insert into/)[0] ?? "";
    expect(upsert).toContain(WORKFLOW_WAKE_TABLE);
    // The upsert, not an insert: a drained queue publishes `null`, and null is a
    // value the platform reads ("nothing pending") rather than an absence.
    expect(upsert).toContain("on conflict (id) do update");
  });

  test("counts a locked job from its lock expiry, not its run_at", async () => {
    const db = recordingDb();
    await createWakeHintPublisher({ db, intervalMs: 0 }).publish();

    const upsert = matching(db, /^insert into/)[0] ?? "";
    // A locked job belongs to a worker; the earliest ANOTHER worker could take
    // it is graphile-worker's job expiry past the lock.
    expect(upsert).toContain(`j.locked_at + interval '${GRAPHILE_JOB_EXPIRY}'`);
    // ...and a permanently-failed job counts for nothing at all: its run_at is
    // forever in the past, so including it would boot a sandbox every sweep for
    // the life of the agent.
    expect(upsert).toContain("j.attempts < j.max_attempts");
  });

  test("writes nothing when the database has no DevKit queue", async () => {
    // The Local World under `aai dev`, or a world that failed to start. A null
    // hint here would be a claim this process cannot make.
    const db = recordingDb({ queuePresent: false });
    await createWakeHintPublisher({ db, intervalMs: 0 }).publish();

    expect(matching(db, /create table|^insert into/)).toEqual([]);
  });

  test("a failure warns once and resolves, so a queue callback never replays over it", async () => {
    const db = recordingDb({ fail: /^insert into/ });
    // Spread over the shared NO-OP logger and spy on the one method under
    // test: a module-level bag of `vi.fn()`s accumulates across the file, so
    // `toHaveBeenCalledTimes(1)` would be a statement about file order.
    const logger = { ...silentLogger, warn: vi.fn() };
    const publisher = createWakeHintPublisher({ db, logger, intervalMs: 0 });

    await expect(publisher.publish()).resolves.toBeUndefined();
    await expect(publisher.publish()).resolves.toBeUndefined();

    // Twice attempted, reported once: the usual cause repeats every minute for
    // the life of the sandbox.
    expect(matching(db, /^insert into/)).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test("a failed DDL is retried rather than remembered as done", async () => {
    const db = recordingDb({ fail: /create table/ });
    const publisher = createWakeHintPublisher({ db, logger: silentLogger, intervalMs: 0 });

    await publisher.publish();
    await publisher.publish();

    // Memoizing the failure would need a redeploy to recover from a transient
    // privilege or connection fault.
    expect(matching(db, /create table/)).toHaveLength(2);
  });

  test("coalesces concurrent triggers into one publish", async () => {
    const db = recordingDb();
    const publisher = createWakeHintPublisher({ db, intervalMs: 0 });

    await Promise.all([publisher.publish(), publisher.publish(), publisher.publish()]);

    // Three triggers, at most two runs (the in-flight one plus one trailing):
    // the answer is a read of latest state, so the collapse loses nothing.
    expect(matching(db, /^insert into/).length).toBeLessThanOrEqual(2);
  });

  test("republishes on the interval, and stops on close", async () => {
    vi.useFakeTimers();
    try {
      const db = recordingDb();
      const publisher = createWakeHintPublisher({ db, intervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(2500);
      const during = matching(db, /^insert into/).length;
      expect(during).toBeGreaterThanOrEqual(2);

      await publisher.close();
      await vi.advanceTimersByTimeAsync(5000);
      expect(matching(db, /^insert into/)).toHaveLength(during);
    } finally {
      vi.useRealTimers();
    }
  });

  test("close does not drop a caller-supplied handle", async () => {
    // The guest owns the pool it injected (or the runtime does); closing
    // someone else's connection from here would take `ctx.db` down with it.
    const db = recordingDb();
    const closed = vi.fn();
    await createWakeHintPublisher({
      db: { ...db, close: closed } as Db,
      intervalMs: 0,
    }).close();

    expect(closed).not.toHaveBeenCalled();
  });
});
