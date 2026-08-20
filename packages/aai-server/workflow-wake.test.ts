// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the durable-run wake sweep.
 *
 * The SQL is asserted against a real Postgres in
 * `workflow-wake.scenario.test.ts` — an in-memory fake cannot tell whether
 * `where wake_at <= now()` really filters, or whether a savepoint really keeps
 * one tenant's unreadable table from taking the pass down. What is asserted here
 * is the POLICY around it, which is where the expensive mistakes live: waking an
 * agent the agents table no longer lists, waking one slug forever because its
 * guest cannot rewrite the hint, and sweeping on ten replicas at once.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import { WORKFLOW_WAKE_NAMESPACE } from "./_workflow-wake-read.ts";
import { type AppDatabases, appDbIdentifier } from "./app-database.ts";
import { type AdminDb, SLUG_LOCK_NAMESPACE } from "./platform-lock.ts";
import type { BrokeredSession } from "./sandbox-broker.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { APP_DB_SECRET_PREFIX, type SqlExec } from "./secret-store.ts";
import { captureLogs, createTestStore, fakeAppDatabases } from "./test-utils.ts";
import { createWorkflowWakeSweep } from "./workflow-wake.ts";

/**
 * The two halves of a pass, faked separately — because they are now two
 * CONNECTIONS.
 *
 * The admin connection elects a leader and reads every app's stored credential
 * out of Vault in one query; each app's hint then comes off a connection into
 * that app's OWN database. `hints` maps a slug to what its read returns: a Date
 * (due), null (has the table, nothing due), `undefined` (no hint table — has a
 * database but runs no workflows), or an Error (a tenant table this platform
 * cannot read).
 */
function fakeAdminDb(opts: {
  hints?: Record<string, Date | null | undefined | Error>;
  locked?: boolean;
  vault?: boolean;
}): AdminDb & { statements: string[] } {
  const slugs = Object.keys(opts.hints ?? {});
  const statements: string[] = [];
  return {
    statements,
    reserve: () =>
      Promise.resolve({
        release: vi.fn(),
        query: (async (sql: string) => {
          statements.push(sql);
          if (sql.includes("pg_try_advisory_xact_lock")) {
            return [{ locked: opts.locked ?? true }];
          }
          if (sql.includes("to_regclass('vault.secrets')")) {
            return [{ present: opts.vault ?? true }];
          }
          if (sql.includes("vault.decrypted_secrets")) {
            return slugs.map((slug) => ({
              name: `${APP_DB_SECRET_PREFIX}${slug}`,
              decrypted_secret: JSON.stringify({
                role: appDbIdentifier(slug),
                password: "0".repeat(32),
              }),
            }));
          }
          return [];
        }) as never,
      }),
  };
}

/** Serves each app's hint from its own database, and records which were opened. */
function fakeWakeAppDb(hints: Record<string, Date | null | undefined | Error>): AppDatabases & {
  opened: string[];
} {
  const byRole = new Map(
    Object.entries(hints).map(([slug, value]) => [appDbIdentifier(slug), value] as const),
  );
  const opened: string[] = [];
  return Object.assign(
    fakeAppDatabases({
      withAppDb: async (meta, fn) => {
        opened.push(meta.role);
        const hint = byRole.get(meta.role);
        // Typed as the real `SqlExec` rather than cast: the contract is what a
        // spec is standing in for, and a cast stops reporting the moment it moves.
        const sql: SqlExec = async (query) => {
          if (query.startsWith("set ")) return [];
          if (query.includes("to_regclass")) return [{ present: hint !== undefined }];
          if (hint instanceof Error) throw hint;
          return [{ wake_at: hint ?? null }];
        };
        return await fn(sql);
      },
    }),
    { opened },
  );
}

/** A store whose `listSlugs` answers what the agents table would. */
function storeWithSlugs(slugs: string[]) {
  const store = createTestStore();
  store.listSlugs = () => Promise.resolve([...slugs].sort());
  return store;
}

const OK: BrokeredSession = {
  ok: true,
  sessionUrl: "wss://sandbox.test/websocket",
  guestOrigin: "wss://sandbox.test",
};

function sweepWith(
  opts: {
    hints?: Record<string, Date | null | undefined | Error>;
    locked?: boolean;
    slugs?: string[];
    wake?: (slug: string) => Promise<BrokeredSession>;
    isDraining?: () => boolean;
    now?: () => number;
    retryMs?: number;
    maxPerTick?: number;
  } = {},
) {
  const hints = opts.hints ?? {};
  const wake = vi.fn(opts.wake ?? (() => Promise.resolve(OK)));
  const adminDb = fakeAdminDb({ ...omitUndefined({ locked: opts.locked }), hints });
  const appDb = fakeWakeAppDb(hints);
  const sweep = createWorkflowWakeSweep({
    adminDb,
    appDb,
    store: storeWithSlugs(opts.slugs ?? Object.keys(hints)),
    broker: { slots: createSlotCache(), store: createTestStore() },
    wake,
    ...omitUndefined({ isDraining: opts.isDraining }),
    ...omitUndefined({ now: opts.now }),
    ...omitUndefined({ retryMs: opts.retryMs, maxPerTick: opts.maxPerTick }),
  });
  return { sweep, wake, adminDb, appDb };
}

const past = new Date("2026-08-12T09:00:00Z");

describe("the sweep's advisory-lock key", () => {
  test("is its own namespace, never the slug lock's", () => {
    // Two ints so the key cannot collide with another advisory-lock user, and a
    // DIFFERENT namespace from the slug lock because this one SKIPS rather than
    // waits: sharing it would read as "the sweep never runs while anything is
    // deploying", which is invisible until a run fails to wake.
    expect(WORKFLOW_WAKE_NAMESPACE).not.toBe(SLUG_LOCK_NAMESPACE);
  });
});

describe("createWorkflowWakeSweep", () => {
  const logs = captureLogs();
  test("wakes a slug whose hint is due", async () => {
    const { sweep, wake } = sweepWith({ hints: { "sleepy-agent": past } });
    const result = await sweep.sweepOnce();

    expect(result.woken).toEqual(["sleepy-agent"]);
    expect(wake).toHaveBeenCalledExactlyOnceWith("sleepy-agent");
  });

  test("leaves an agent with nothing due alone", async () => {
    const { sweep, wake } = sweepWith({
      hints: { "sleepy-agent": null, "busy-agent": past },
    });
    const result = await sweep.sweepOnce();

    expect(result.woken).toEqual(["busy-agent"]);
    expect(result.candidates).toBe(2);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  test("never wakes a slug the agents table no longer lists", async () => {
    // The structural guard against resurrecting a deleted agent: an app schema
    // outlives its row until the orphan sweep runs, so a due hint can genuinely
    // be sitting there with nobody it belongs to.
    const { sweep, wake } = sweepWith({ hints: { "deleted-agent": past }, slugs: [] });
    const result = await sweep.sweepOnce();

    expect(result.woken).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  test("a 404 is not counted as an attempt, so nothing backs off from it", async () => {
    // The second guard: the row went away between listing and brokering. There
    // is nothing to retry and nothing to remember.
    const { sweep, wake } = sweepWith({
      hints: { gone: past },
      wake: () => Promise.resolve({ ok: false, status: 404 }),
    });

    const first = await sweep.sweepOnce();
    expect(first.woken).toEqual([]);
    expect(first.skipped).toBe(1);

    await sweep.sweepOnce();
    expect(wake).toHaveBeenCalledTimes(2);
  });

  test("a still-booting 503 counts as an attempt", async () => {
    // The boot continues server-side, so hammering it every interval would
    // spawn nothing and cost a broker call per tick.
    const { sweep, wake } = sweepWith({
      hints: { booting: past },
      wake: () => Promise.resolve({ ok: false, status: 503 }),
      retryMs: 60_000,
      now: () => 1000,
    });

    await sweep.sweepOnce();
    await sweep.sweepOnce();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  test("backs off a woken slug, then wakes it again once the window passes", async () => {
    // The bound on a wake LOOP: a guest that boots and cannot run its world
    // never rewrites the hint, so its slug stays due forever.
    let clock = 0;
    const { sweep, wake } = sweepWith({
      hints: { looping: past },
      retryMs: 10_000,
      now: () => clock,
    });

    await sweep.sweepOnce();
    clock = 5000;
    await sweep.sweepOnce();
    expect(wake).toHaveBeenCalledTimes(1);

    clock = 10_001;
    await sweep.sweepOnce();
    expect(wake).toHaveBeenCalledTimes(2);
  });

  test("caps the boots one tick may start", async () => {
    const hints = Object.fromEntries(["a", "b", "c", "d"].map((slug) => [slug, past]));
    const { sweep, wake } = sweepWith({ hints, maxPerTick: 2 });

    const result = await sweep.sweepOnce();
    expect(result.woken).toHaveLength(2);
    expect(result.due).toBe(4);
    expect(result.skipped).toBe(2);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  test("does nothing when another replica holds the lock", async () => {
    const { sweep, wake } = sweepWith({ hints: { "sleepy-agent": past }, locked: false });
    const result = await sweep.sweepOnce();

    expect(result.swept).toBe(false);
    expect(wake).not.toHaveBeenCalled();
  });

  test("does not read or boot while this replica is draining", async () => {
    const { sweep, wake, adminDb } = sweepWith({
      hints: { "sleepy-agent": past },
      isDraining: () => true,
    });
    const result = await sweep.sweepOnce();

    expect(result.swept).toBe(false);
    expect(wake).not.toHaveBeenCalled();
    expect(adminDb.statements).toEqual([]);
  });

  test("one tenant's unreadable hint does not cost the others their wake", async () => {
    // A savepoint per read is what makes this true; without one the first failed
    // statement aborts the transaction and every later tenant is skipped.
    const { sweep, wake } = sweepWith({
      hints: { "poisoned-agent": new Error("relation does not exist"), "sleepy-agent": past },
    });
    const result = await sweep.sweepOnce();

    expect(result.woken).toEqual(["sleepy-agent"]);
    expect(wake).toHaveBeenCalledExactlyOnceWith("sleepy-agent");
  });

  test("a read failure fails the pass, not the sweep", async () => {
    const adminDb: AdminDb = { reserve: () => Promise.reject(new Error("no connections")) };
    const sweep = createWorkflowWakeSweep({
      adminDb,
      appDb: fakeWakeAppDb({}),
      store: storeWithSlugs(["sleepy-agent"]),
      broker: { slots: createSlotCache(), store: createTestStore() },
      wake: () => Promise.resolve(OK),
    });

    await expect(sweep.sweepOnce()).resolves.toMatchObject({ swept: false });
    expect(logs.warns()).not.toHaveLength(0);
  });

  test("a wake that throws is reported and does not abandon the remaining slugs", async () => {
    const { sweep, wake } = sweepWith({
      hints: { "a-agent": past, "b-agent": past },
      wake: (slug) =>
        slug === "a-agent" ? Promise.reject(new Error("modal down")) : Promise.resolve(OK),
    });

    const result = await sweep.sweepOnce();
    expect(wake).toHaveBeenCalledTimes(2);
    expect(result.woken).toContain("b-agent");
    expect(logs.warns()).not.toHaveLength(0);
  });

  test("the statement timeout is scoped to the transaction, not the pooled connection", () => {
    // A bare `set statement_timeout` would ride the released connection back
    // into every other platform query — postgres.js keeps session state across
    // `release()` (see platform-lock.ts).
    const { sweep, adminDb } = sweepWith({ hints: { "sleepy-agent": past } });
    return sweep.sweepOnce().then(() => {
      expect(adminDb.statements).toContain("begin");
      expect(adminDb.statements.some((sql) => /^set local statement_timeout/.test(sql))).toBe(true);
      expect(adminDb.statements).toContain("commit");
    });
  });

  test("start/stop is idempotent and does not tick after stopping", async () => {
    vi.useFakeTimers();
    try {
      const { sweep, wake } = sweepWith({ hints: { "sleepy-agent": past }, retryMs: 0 });
      const stop = sweep.start(1000);
      await vi.advanceTimersByTimeAsync(2500);
      const ticks = wake.mock.calls.length;
      expect(ticks).toBeGreaterThanOrEqual(2);

      stop();
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(wake.mock.calls).toHaveLength(ticks);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an interval of 0 starts nothing — the documented kill switch", async () => {
    vi.useFakeTimers();
    try {
      const { sweep, wake } = sweepWith({ hints: { "sleepy-agent": past } });
      sweep.start(0);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(wake).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
