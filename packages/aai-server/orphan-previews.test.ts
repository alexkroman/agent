// Copyright 2026 the AAI authors. MIT license.
import { PREVIEW_SLUG_SUFFIX } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import type { LeaderDb } from "./orphan-previews.ts";
import { createOrphanPreviewSweep, startOrphanPreviewSweep } from "./orphan-previews.ts";
import type { SqlExec } from "./secret-store.ts";
import { createMemorySecretStore } from "./secret-store.ts";
import { captureLogs, createTestStore, fakeAppDatabases } from "./test-utils.ts";

/**
 * A fake {@link LeaderDb} whose reserved connection records every statement and
 * answers the leader try-lock with `locked`.
 *
 * The reservation is what the sweep needs for connection affinity, so `released`
 * is asserted too: a pass that leaks a reserved admin connection takes one out of
 * the budget for the life of the process.
 */
function fakeAdminDb(opts: { locked?: boolean; slugs?: string[] } = {}) {
  const queries: { text: string; params?: unknown[] | undefined }[] = [];
  let released = 0;
  const query: SqlExec = async (text, params) => {
    queries.push({ text, params });
    if (text.includes("pg_try_advisory_xact_lock")) return [{ locked: opts.locked ?? true }];
    if (text.includes("aai_platform.agents")) return (opts.slugs ?? []).map((slug) => ({ slug }));
    return [];
  };
  const adminDb: LeaderDb = {
    reserve: async () => ({
      query,
      release: () => {
        released += 1;
      },
    }),
  };
  return { adminDb, queries, released: () => released };
}

function fakeEnv() {
  return {
    store: createTestStore(),
    secrets: createMemorySecretStore(),
    slugLock: <T>(_slug: string, fn: () => Promise<T>) => fn(),
    appDb: fakeAppDatabases(),
  };
}

const logs = captureLogs();

describe("createOrphanPreviewSweep", () => {
  test("reaps every aged, unreferenced preview through the one delete path", async () => {
    const { adminDb, released } = fakeAdminDb({ slugs: ["a-preview", "b-preview"] });
    const reap = vi.fn(async (_slug: string) => undefined);
    const sweep = createOrphanPreviewSweep({ adminDb, env: fakeEnv(), reap });
    expect(await sweep.sweepOnce()).toEqual({
      swept: true,
      reaped: ["a-preview", "b-preview"],
      failed: [],
    });
    expect(reap.mock.calls.map((call) => call[0])).toEqual(["a-preview", "b-preview"]);
    // The reserved connection is released even on the happy path.
    expect(released()).toBe(1);
  });

  test("selects only aged previews no workspace points at, with bound parameters", async () => {
    const { adminDb, queries } = fakeAdminDb({ slugs: [] });
    await createOrphanPreviewSweep({ adminDb, env: fakeEnv() }).sweepOnce();
    const read = queries.find((q) => q.text.includes("aai_platform.agents"));
    // Only `-preview` slugs, and via a PARAMETER: the pg_cron body had to
    // interpolate the suffix into stored SQL behind a wildcard-safety assertion.
    expect(read?.params?.[0]).toBe(`%${PREVIEW_SLUG_SUFFIX}`);
    expect(read?.text).toContain("a.slug like $1");
    // The workspace back-reference is what marks a preview as live, joined
    // through the indexed generated column rather than dug out of `doc`.
    expect(read?.text).toContain("w.preview_slug = a.slug");
    expect(read?.text).not.toContain("doc->>'previewSlug'");
    // Age floor: a preview whose workspace stamp has not landed yet is not an
    // orphan.
    expect(read?.text).toContain("interval '1 hour'");
    // Bounded per pass, since each reap takes a slug lock and calls the control
    // plane.
    expect(read?.params?.[1]).toBe(20);
  });

  test("SELECTS candidates rather than deleting them, so a crash is retryable", async () => {
    // The SQL version deleted the rows in the statement that returned them, so a
    // body that died mid-loop left every remaining database orphaned with nothing
    // naming it. The row here is `deleteAgentResources`'s last act.
    const { adminDb, queries } = fakeAdminDb({ slugs: ["a-preview"] });
    await createOrphanPreviewSweep({
      adminDb,
      env: fakeEnv(),
      reap: async () => undefined,
    }).sweepOnce();
    for (const q of queries) expect(q.text).not.toMatch(/^delete from/);
  });

  test("does nothing when another replica holds the leader lock", async () => {
    // `try_` rather than a wait: a pass another replica is already running is a
    // pass this one has nothing to add to.
    const { adminDb, queries, released } = fakeAdminDb({ locked: false, slugs: ["a-preview"] });
    const reap = vi.fn(async (_slug: string) => undefined);
    expect(await createOrphanPreviewSweep({ adminDb, env: fakeEnv(), reap }).sweepOnce()).toEqual({
      swept: false,
      reaped: [],
      failed: [],
    });
    expect(reap).not.toHaveBeenCalled();
    // It never even reads the candidates, and it still releases.
    expect(queries.some((q) => q.text.includes("aai_platform.agents"))).toBe(false);
    expect(released()).toBe(1);
  });

  test("holds the lock for the READ and commits before reaping", async () => {
    // Each reap takes the slug lock and calls the control plane; holding a
    // reserved admin connection across that is what platform-lock.ts warns about.
    const { adminDb, queries } = fakeAdminDb({ slugs: ["a-preview"] });
    let committedBefore: string[] = [];
    await createOrphanPreviewSweep({
      adminDb,
      env: fakeEnv(),
      reap: async () => {
        committedBefore = queries.map((q) => q.text);
      },
    }).sweepOnce();
    expect(committedBefore).toContain("begin");
    expect(committedBefore).toContain("commit");
  });

  test("one failing slug does not park the rest, and is reported", async () => {
    // A cluster that will not answer must not hold up every other orphan; the
    // failures come back next pass, because their rows are still there.
    const { adminDb } = fakeAdminDb({ slugs: ["bad-preview", "good-preview"] });
    const sweep = createOrphanPreviewSweep({
      adminDb,
      env: fakeEnv(),
      reap: async (slug) => {
        if (slug === "bad-preview") throw new Error("cluster down");
      },
    });
    expect(await sweep.sweepOnce()).toEqual({
      swept: true,
      reaped: ["good-preview"],
      failed: ["bad-preview"],
    });
    expect(logs.warns()).not.toHaveLength(0);
  });

  test("releases the reserved connection even when the read throws", async () => {
    let released = 0;
    const adminDb: LeaderDb = {
      reserve: async () => ({
        query: async (text: string) => {
          if (text.includes("pg_try_advisory_xact_lock")) throw new Error("connection lost");
          return [];
        },
        release: () => {
          released += 1;
        },
      }),
    };
    await expect(createOrphanPreviewSweep({ adminDb, env: fakeEnv() }).sweepOnce()).rejects.toThrow(
      "connection lost",
    );
    expect(released).toBe(1);
  });

  test("start() ticks on the interval and stop() clears the timer", async () => {
    // Counted through the fake's own statements rather than a spy on the
    // returned object: `start` closes over the pass, so a property spy would
    // pass while intercepting nothing.
    vi.useFakeTimers();
    try {
      const { adminDb, queries } = fakeAdminDb({ slugs: [] });
      const passes = () => queries.filter((q) => q.text.includes("pg_try_advisory")).length;
      const stop = createOrphanPreviewSweep({ adminDb, env: fakeEnv() }).start(1000);
      await vi.advanceTimersByTimeAsync(2500);
      expect(passes()).toBeGreaterThanOrEqual(2);
      stop();
      const after = passes();
      await vi.advanceTimersByTimeAsync(5000);
      expect(passes()).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startOrphanPreviewSweep", () => {
  test("does not start without a platform database", () => {
    const stop = startOrphanPreviewSweep({ store: createTestStore() });
    expect(stop()).toBeUndefined();
  });

  test("does not start without the secrets store or the slug lock", () => {
    // Both are required to reap at all: the secret holds the app database's
    // locator, and the lock is what stops a reap racing a deploy of the slug.
    const { adminDb } = fakeAdminDb();
    const env = fakeEnv();
    expect(
      startOrphanPreviewSweep({ adminDb, store: env.store, slugLock: env.slugLock })(),
    ).toBeUndefined();
    expect(
      startOrphanPreviewSweep({ adminDb, store: env.store, secrets: env.secrets })(),
    ).toBeUndefined();
  });

  test("starts with a full composition, and an interval of 0 opts out", () => {
    const { adminDb } = fakeAdminDb();
    const env = fakeEnv();
    const started = startOrphanPreviewSweep({ adminDb, ...env, intervalMs: 3_600_000 });
    expect(started).toBeInstanceOf(Function);
    started();
    expect(startOrphanPreviewSweep({ adminDb, ...env, intervalMs: 0 })()).toBeUndefined();
  });
});
