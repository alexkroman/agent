// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the orphaned-queue-lock sweep.
 *
 * Driven against a fake `CloseableDb` rather than a real Postgres, because what
 * this module decides is a POLICY and the policy is what can be wrong: sweep only
 * when no other pool is alive, unlock exactly the workers found holding locks, and
 * hold presence afterwards so the next pool to start reads us as live.
 *
 * The one thing a fake cannot check is that `graphile_worker.force_unlock_workers`
 * exists and does what its name says. That is verified against a real database —
 * see the module doc; `packages/aai` has no Postgres-gated tier, since
 * `describeWithPg` lives in `aai-server`, which this package may not import.
 */

import { describe, expect, test, vi } from "vitest";
import type { CloseableDb, ReservedDb } from "./postgres-db.ts";
import { claimPoolPresenceAndSweep } from "./workflow-lock-sweep.ts";

type Recorded = { query: string; params: unknown[] | undefined };

/**
 * A `CloseableDb` that answers by pattern and records every statement.
 *
 * `presenceHeld` is the whole point of the double: it is what a real
 * `pg_try_advisory_lock` returns, and every branch worth testing hangs off it.
 */
function fakeDb(opts: { presenceHeld?: boolean; lockedBy?: string[] } = {}) {
  const calls: Recorded[] = [];
  const released = vi.fn();
  const closed = vi.fn();

  const query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
    calls.push({ query: sql, params });
    if (sql.includes("pg_try_advisory_lock")) {
      return [{ held: opts.presenceHeld ?? true }] as T[];
    }
    if (sql.includes("locked_by")) {
      return (opts.lockedBy ?? []).map((id) => ({ locked_by: id })) as T[];
    }
    return [] as T[];
  };

  // Typed rather than cast into place. `Db` is one generic method, so a real
  // `ReservedDb`/`CloseableDb` is three lines — where a double cast through
  // `unknown` would keep compiling if either type GAINED a member, leaving it
  // undefined here and the code under test failing on a `TypeError` that names
  // nothing. (Wording matters as well as the code: `check:hatches` matches plain
  // substrings, so a comment naming the pattern scores as one.)
  const reserved: ReservedDb = { query, release: released };
  const db: CloseableDb = {
    query,
    reserve: async () => reserved,
    close: async () => {
      closed();
    },
  };

  return {
    db,
    calls,
    released,
    closed,
    /** Statements matching a fragment, for asserting what ran. */
    matching: (fragment: string) => calls.filter((call) => call.query.includes(fragment)),
  };
}

/** Swallow the module's own log lines; one spec asserts them explicitly instead. */
const silent = { log: (_message: string) => undefined };

describe("claimPoolPresenceAndSweep", () => {
  test("sweeps exactly the workers found holding locks", async () => {
    const fake = fakeDb({ presenceHeld: true, lockedBy: ["worker-a", "worker-b"] });
    const result = await claimPoolPresenceAndSweep("postgres://x", {
      ...silent,
      createDb: () => fake.db,
    });

    expect(result.swept).toEqual(["worker-a", "worker-b"]);
    expect(result.skipped).toBeUndefined();
    expect(result.held).toBe(true);
    const unlock = fake.matching("force_unlock_workers");
    expect(unlock).toHaveLength(1);
    expect(unlock[0]?.params).toEqual([["worker-a", "worker-b"]]);
    await result.release();
  });

  test("a live sibling pool means it sweeps NOTHING", async () => {
    // The case that makes the advisory lock load-bearing rather than decoration:
    // unlocking a job a live worker is executing runs that step twice, which is
    // worse than the wedge. `aai dev` against a production DATABASE_URL is the
    // configuration that really reaches this.
    const fake = fakeDb({ presenceHeld: false, lockedBy: ["worker-live"] });
    const result = await claimPoolPresenceAndSweep("postgres://x", {
      ...silent,
      createDb: () => fake.db,
    });

    expect(result.skipped).toBe("another-pool-is-live");
    expect(result.swept).toEqual([]);
    expect(result.held).toBe(false);
    expect(fake.matching("force_unlock_workers")).toHaveLength(0);
    // It must not even LOOK for orphans: the answer could not be acted on.
    expect(fake.matching("locked_by")).toHaveLength(0);
  });

  test("it releases the connection when it declines to sweep", async () => {
    // A reservation held for the life of a process that is not the presence
    // holder permanently shrinks a pool of one to zero.
    const fake = fakeDb({ presenceHeld: false });
    await claimPoolPresenceAndSweep("postgres://x", { ...silent, createDb: () => fake.db });
    expect(fake.released).toHaveBeenCalled();
    expect(fake.closed).toHaveBeenCalled();
  });

  test("nothing locked is reported as such, and presence is still HELD", async () => {
    // The healthy boot. Presence still has to be taken, or the next pool to start
    // would read this one as dead and sweep the jobs it is running.
    const fake = fakeDb({ presenceHeld: true, lockedBy: [] });
    const result = await claimPoolPresenceAndSweep("postgres://x", {
      ...silent,
      createDb: () => fake.db,
    });

    expect(result.skipped).toBe("no-orphaned-locks");
    expect(result.held).toBe(true);
    expect(fake.matching("force_unlock_workers")).toHaveLength(0);
    expect(fake.released).not.toHaveBeenCalled();
    await result.release();
  });

  test("release unlocks the advisory lock and closes the connection", async () => {
    const fake = fakeDb({ presenceHeld: true, lockedBy: ["worker-a"] });
    const result = await claimPoolPresenceAndSweep("postgres://x", {
      ...silent,
      createDb: () => fake.db,
    });
    await result.release();

    expect(fake.matching("pg_advisory_unlock")).toHaveLength(1);
    expect(fake.released).toHaveBeenCalled();
    expect(fake.closed).toHaveBeenCalled();
  });

  test("release is idempotent", async () => {
    const fake = fakeDb({ presenceHeld: true });
    const result = await claimPoolPresenceAndSweep("postgres://x", {
      ...silent,
      createDb: () => fake.db,
    });
    await result.release();
    await result.release();
    expect(fake.matching("pg_advisory_unlock")).toHaveLength(1);
  });

  test("it reads the PUBLIC jobs view and no underscore-private relation", async () => {
    // The first draft also unioned `graphile_worker.job_queues`, which does not
    // exist in 0.16.6 — every spec here passed against the fake while the real
    // statement failed `relation … does not exist`, so the sweep would have thrown
    // on every boot and left the wedge in place. A fake cannot check a schema;
    // what it CAN pin is that this only ever names the public view.
    const fake = fakeDb({ presenceHeld: true, lockedBy: ["worker-a"] });
    const result = await claimPoolPresenceAndSweep("postgres://x", {
      ...silent,
      createDb: () => fake.db,
    });
    const lookup = fake.matching("locked_by")[0]?.query ?? "";
    expect(lookup).toContain("graphile_worker.jobs");
    expect(lookup).not.toContain("_private");
    await result.release();
  });

  test("a failure closes what it opened rather than leaking the connection", async () => {
    const fake = fakeDb({ presenceHeld: true });
    const db: CloseableDb = {
      query: fake.db.query,
      reserve: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      close: fake.db.close,
    };

    await expect(
      claimPoolPresenceAndSweep("postgres://x", { ...silent, createDb: () => db }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(fake.closed).toHaveBeenCalled();
  });

  test("it reports what it cleared, naming the workers", async () => {
    // The log line is the only trace a sweep leaves, and "did recovery happen"
    // has to be answerable from it.
    const log = vi.fn();
    const fake = fakeDb({ presenceHeld: true, lockedBy: ["worker-dead"] });
    const result = await claimPoolPresenceAndSweep("postgres://x", {
      log,
      createDb: () => fake.db,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("worker-dead"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1 dead worker"));
    await result.release();
  });
});
