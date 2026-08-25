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

import { sleep } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import { WORKFLOW_WAKE_NAMESPACE } from "./_workflow-wake-read.ts";
import { type AppDatabases, appDbIdentifier } from "./app-database.ts";
import { WORKFLOW_WAKE_INTERVAL_MS } from "./constants.ts";
import { type AdminDb, SLUG_LOCK_NAMESPACE } from "./platform-lock.ts";
import type { BrokeredSession } from "./sandbox-broker.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { APP_DB_SECRET_PREFIX, type SqlExec } from "./secret-store.ts";
import {
  captureLogs,
  createTestOrchestrator,
  createTestStore,
  fakeAppDatabases,
} from "./test-utils.ts";
import { createWorkflowWakeSweep, startWorkflowWakeSweep } from "./workflow-wake.ts";

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

/**
 * Serves each app's hint from its own database, recording which were opened and
 * — because the read phase fans out now — how many were open AT ONCE.
 *
 * `peak` is what holds `WORKFLOW_WAKE_READ_CONCURRENCY` to a real bound: the
 * width is a property of a semaphore rather than of the loop shape, so a spec
 * that only counted calls would pass for any width including unbounded.
 * `delays` makes a named app's read settle later than the others, which is how
 * the ordering guard below gets to observe completion order diverging from slug
 * order — index-aligned results are the only reason `due` still means what
 * `workflow-wake.ts`'s per-tick cap needs it to.
 */
function fakeWakeAppDb(
  hints: Record<string, Date | null | undefined | Error>,
  delays: Record<string, number> = {},
): AppDatabases & { opened: string[]; peak: () => number } {
  const byRole = new Map(
    Object.entries(hints).map(([slug, value]) => [appDbIdentifier(slug), value] as const),
  );
  const delayByRole = new Map(
    Object.entries(delays).map(([slug, ms]) => [appDbIdentifier(slug), ms] as const),
  );
  const opened: string[] = [];
  const tracker = { peak: 0 };
  let inFlight = 0;
  return Object.assign(
    fakeAppDatabases({
      withAppDb: async (meta, fn) => {
        opened.push(meta.role);
        inFlight += 1;
        tracker.peak = Math.max(tracker.peak, inFlight);
        try {
          // A real wait, so overlap is observable at all: every read resolving
          // in one microtask would make any width look like a width of one.
          await sleep(delayByRole.get(meta.role) ?? 1);
          return await servedHint(byRole, meta.role, fn);
        } finally {
          inFlight -= 1;
        }
      },
    }),
    // A function, not a getter: `Object.assign` copies a getter's VALUE at
    // assign time, which is 0 before any read has run.
    { opened, peak: () => tracker.peak },
  );
}

/** One app's hint read, on a `SqlExec` typed as the real contract. */
function servedHint<T>(
  byRole: Map<string, Date | null | undefined | Error>,
  role: string,
  fn: (sql: SqlExec) => Promise<T>,
): Promise<T> {
  const hint = byRole.get(role);
  // Typed as the real `SqlExec` rather than cast: the contract is what a spec is
  // standing in for, and a cast stops reporting the moment it moves.
  const sql: SqlExec = async (query) => {
    if (query.startsWith("set ")) return [];
    if (query.includes("to_regclass")) return [{ present: hint !== undefined }];
    if (hint instanceof Error) throw hint;
    return [{ wake_at: hint ?? null }];
  };
  return fn(sql);
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
    readConcurrency?: number;
    readTimeoutMs?: number;
    /** Per-slug read latency, so completion order can diverge from slug order. */
    delays?: Record<string, number>;
  } = {},
) {
  const hints = opts.hints ?? {};
  const wake = vi.fn(opts.wake ?? (() => Promise.resolve(OK)));
  const adminDb = fakeAdminDb({ ...omitUndefined({ locked: opts.locked }), hints });
  const appDb = fakeWakeAppDb(hints, opts.delays ?? {});
  const sweep = createWorkflowWakeSweep({
    adminDb,
    appDb,
    store: storeWithSlugs(opts.slugs ?? Object.keys(hints)),
    broker: { slots: createSlotCache(), store: createTestStore() },
    wake,
    ...omitUndefined({ isDraining: opts.isDraining }),
    ...omitUndefined({ now: opts.now }),
    ...omitUndefined({ retryMs: opts.retryMs, maxPerTick: opts.maxPerTick }),
    ...omitUndefined({
      readConcurrency: opts.readConcurrency,
      readTimeoutMs: opts.readTimeoutMs,
    }),
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

/**
 * The read phase's WIDTH, which is the thing a serial loop used to make
 * incidental.
 *
 * These reads each open a real connection into one tenant's database, so the
 * width is a term in the platform's connection budget
 * (`APP_DB_ADMIN_POOL_MAX`'s doc names this constant as the bound). It used to be
 * one-at-a-time, which bounded the connections at 1 and the pass duration at
 * nothing — at a few hundred apps a pass outran its own 60s interval, and an
 * overrunning pass is skipped rather than queued, so the sweep rate silently
 * halved. What matters in both directions is asserted here: that it really does
 * overlap (a cap alone would pass for a width of one) and that it really does
 * cap (a fan-out alone would pass for a width of the app count).
 */
describe("the read phase's concurrency", () => {
  const logs = captureLogs();
  const eight = Object.fromEntries(
    ["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => [`app-${n}`, past] as const),
  );

  test("reads several app databases at once, and never more than the width", async () => {
    const { sweep, appDb } = sweepWith({ hints: eight, readConcurrency: 3, maxPerTick: 0 });
    const result = await sweep.sweepOnce();

    expect(appDb.opened).toHaveLength(8);
    expect(appDb.peak()).toBe(3);
    expect(result.due).toBe(8);
    expect(logs.errors()).toEqual([]);
  });

  test("a width of 1 is the serial pass it replaced", async () => {
    // The documented escape hatch (`WORKFLOW_WAKE_READ_CONCURRENCY=1`), and the
    // control for the test above: same fan-out code, no overlap.
    const { sweep, appDb } = sweepWith({ hints: eight, readConcurrency: 1, maxPerTick: 0 });
    await sweep.sweepOnce();

    expect(appDb.opened).toHaveLength(8);
    expect(appDb.peak()).toBe(1);
  });

  test("due slugs keep SLUG order however the databases answer", async () => {
    // The hazard the fan-out introduces and the reason results are reduced in
    // index order rather than appended from inside the tasks: `workflow-wake.ts`
    // takes the first `maxPerTick` of `due` and rests on that order being the
    // slug order, so the cap cannot starve one agent forever. Here the first
    // slug's database is the slowest to answer, so completion order is the
    // reverse of what the cap needs.
    const { sweep, wake } = sweepWith({
      hints: { "app-a": past, "app-b": past, "app-c": past },
      delays: { "app-a": 30, "app-b": 15, "app-c": 1 },
      readConcurrency: 3,
      maxPerTick: 2,
    });
    const result = await sweep.sweepOnce();

    expect(result.woken).toEqual(["app-a", "app-b"]);
    expect(result.skipped).toBe(1);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  test("EVERY app is read, however slow the ones ahead of it are", async () => {
    // The property a bounded width must not cost, and the bug the first draft of
    // this fan-out had: with a semaphore, every candidate asks for its slot at
    // t=0, so the acquire deadline is measured from then rather than from its
    // turn. At K=4 with a 5s deadline that silently drops everything past ~the
    // two-hundredth app on EVERY tick — worse than the serial loop, which was
    // slow but read everyone. A worker pool has no such deadline.
    const slow = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`app-${String(i).padStart(2, "0")}`, past] as const),
    );
    const { sweep, appDb } = sweepWith({
      hints: slow,
      // Every read slower than any per-read budget would be.
      delays: Object.fromEntries(Object.keys(slow).map((slug) => [slug, 20] as const)),
      readConcurrency: 2,
      readTimeoutMs: 5,
      maxPerTick: 0,
    });
    const result = await sweep.sweepOnce();

    expect(appDb.opened).toHaveLength(12);
    expect(result.candidates).toBe(12);
    expect(result.due).toBe(12);
    expect(logs.errors()).toEqual([]);
  });
});

/**
 * WIRING — the half of this feature that a policy spec cannot see.
 *
 * Every test above drives `createWorkflowWakeSweep`, which takes `adminDb` and
 * `appDb` as REQUIRED fields. The composition calls `startWorkflowWakeSweep`,
 * where both are optional so that a platform with no database starts nothing —
 * and that optionality is what let the real bug land: #1130 moved each hint into
 * its app's own database, making `appDb` load-bearing, and `orchestrator.ts`
 * went on passing only `adminDb`. It type-checked, no spec touched this
 * function, and the sweep reported "no platform database" at a level
 * `consoleLogger` drops unless `AAI_DEBUG=1`. The durable-run wake mechanism was
 * off in production, with the only evidence being a log line that never
 * appeared.
 *
 * So these assert on the LOG, which is the whole observable surface of the
 * decision, and the orchestrator spec below asserts the call site itself.
 */
describe("starting the sweep from a composition", () => {
  const logs = captureLogs();
  const base = { store: createTestStore(), broker: { slots: createSlotCache() } } as Parameters<
    typeof startWorkflowWakeSweep
  >[0];

  test("both bindings present starts it, and says so", () => {
    const stop = startWorkflowWakeSweep({
      ...base,
      adminDb: fakeAdminDb({ hints: {} }),
      appDb: fakeAppDatabases(),
    });
    try {
      // The recorded line carries its namespace — see `createLogger`.
      expect(logs.infos()).toEqual([
        `workflow.wake sweeping for due durable runs every ${WORKFLOW_WAKE_INTERVAL_MS}ms`,
      ]);
      expect(logs.errors()).toEqual([]);
    } finally {
      stop();
    }
  });

  test("neither binding is local dev, and stays quiet", () => {
    startWorkflowWakeSweep(base);
    expect(logs.errors()).toEqual([]);
    expect(logs.infos()).toEqual([]);
  });

  test("adminDb without appDb WARNS, naming appDb — the bug this had", () => {
    // The exact shape `orchestrator.ts` shipped. It must not be reportable as
    // "no platform database": there IS one, and the sweep simply cannot read a
    // hint out of it.
    startWorkflowWakeSweep({ ...base, adminDb: fakeAdminDb({ hints: {} }) });

    expect(logs.warns()).toHaveLength(1);
    expect(logs.warns()[0]).toContain("no appDb");
    expect(logs.warns()[0]).not.toContain("no platform database");
    expect(logs.infos()).toEqual([]);
  });

  test("appDb without adminDb is the same warning, naming adminDb", () => {
    startWorkflowWakeSweep({ ...base, appDb: fakeAppDatabases() });

    expect(logs.warns()).toHaveLength(1);
    expect(logs.warns()[0]).toContain("no adminDb");
  });

  test("a half-wired composition is never an ERROR", () => {
    // `error` is what this used to be, and it mislabelled the one shape that is
    // actually reachable: a narrow spec composition passing `appDb` alone. In
    // production both bindings arrive together in one `...base` spread, so
    // neither direction occurs there — see the branch's own comment.
    startWorkflowWakeSweep({ ...base, appDb: fakeAppDatabases() });
    startWorkflowWakeSweep({ ...base, adminDb: fakeAdminDb({ hints: {} }) });

    expect(logs.errors()).toEqual([]);
  });

  test("the interval-0 kill switch is INFO, not a warning", () => {
    startWorkflowWakeSweep({
      ...base,
      adminDb: fakeAdminDb({ hints: {} }),
      appDb: fakeAppDatabases(),
      intervalMs: 0,
    });

    expect(logs.warns()).toEqual([]);
    expect(logs.infos()).toEqual(["workflow.wake Workflow wake sweep not started: interval is 0"]);
  });
});

/**
 * The CALL SITE, which is where the bug actually was.
 *
 * The suite above pins what `startWorkflowWakeSweep` does with each argument
 * shape; nothing pinned which shape the composition hands it, and that is the
 * gap the whole feature fell through. `appDb` is optional on the wrapper — it
 * has to be, so a composition with no platform database starts nothing — so
 * dropping it from this call was invisible to `tsc`, to `publint`, to every
 * policy spec in this file, and to production logs.
 *
 * Asserted through `createOrchestrator` rather than by reading its argument
 * object, because the argument object is not the claim: the claim is that a
 * composition WITH a platform database ends up with a running sweep.
 */
describe("the orchestrator's wiring", () => {
  const logs = captureLogs();

  test("a composition with a platform database starts the sweep", async () => {
    await createTestOrchestrator({
      adminDb: fakeAdminDb({ hints: {} }),
      appDb: fakeAppDatabases(),
    });

    // The warning branch is the miswiring the composition shipped; the info line
    // is the only positive evidence that the sweep is on.
    expect(logs.warns().filter((m) => m.includes("wake"))).toEqual([]);
    expect(logs.infos()).toContain(
      `workflow.wake sweeping for due durable runs every ${WORKFLOW_WAKE_INTERVAL_MS}ms`,
    );
  });

  test("a composition with no platform database starts nothing, quietly", async () => {
    await createTestOrchestrator();

    expect(logs.warns().filter((m) => m.includes("wake"))).toEqual([]);
    expect(logs.infos().filter((m) => m.includes("durable runs"))).toEqual([]);
  });
});
