// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { createMemoryAgentRows } from "./agent-store.ts";
import { createMemoryBlobStorage } from "./blob-storage.ts";
import { createBundleStore } from "./bundle-store.ts";
import {
  type AdminDb,
  assertSessionModeUrl,
  createMutationLock,
  createPgSlugLock,
  localSlugLock,
  SLUG_LOCK_NAMESPACE,
  SlugLockTimeoutError,
} from "./platform-lock.ts";
import { createMemorySecretStore } from "./secret-store.ts";
import { captureLogs } from "./test-utils.ts";

/** The Postgres error a statement that hit `lock_timeout` raises. */
class LockTimeout extends Error {
  code = "55P03";
}

/**
 * Fake admin pool implementing advisory-lock semantics over an in-memory
 * held-key set: acquire blocks while another connection holds the key, and
 * releasing the CONNECTION frees whatever it held (which is the property the
 * real lock depends on for crash safety).
 */
function fakeAdvisoryDb(opts: { timeoutOnContention?: boolean } = {}) {
  const held = new Set<string>();
  const statements: string[] = [];
  let reservations = 0;
  let live = 0;

  const db: AdminDb = {
    // Nothing here listens, and the member is spelled out rather than cast: this
    // fake is typed EXPLICITLY so a widened `AdminDb` surfaces at compile time,
    // which is how this line came to exist.
    listen: () => Promise.resolve(() => undefined),
    reserve() {
      reservations++;
      live++;
      const mine = new Set<string>();
      let released = false;
      return Promise.resolve({
        query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
          const rows = (value: Record<string, unknown>[]): Promise<T[]> =>
            Promise.resolve(value as T[]);
          statements.push(sql);
          if (sql.startsWith("set lock_timeout")) return rows([]);
          const key = String((params ?? [])[1]);
          if (sql.includes("pg_advisory_unlock")) {
            held.delete(key);
            mine.delete(key);
            return rows([]);
          }
          if (held.has(key)) {
            // A real acquire would block here; the fake either raises the
            // lock_timeout error or never resolves, mirroring the two
            // outcomes Postgres can produce.
            return opts.timeoutOnContention
              ? Promise.reject(new LockTimeout("canceling statement due to lock timeout"))
              : new Promise<T[]>(() => undefined);
          }
          held.add(key);
          mine.add(key);
          return rows([]);
        },
        release() {
          if (released) return;
          released = true;
          live--;
          // Deliberately does NOT drop `mine`: postgres.js `release()` returns
          // the connection to the POOL with its session state intact, so an
          // advisory lock survives it. The explicit unlock is what frees the
          // lock; a dropped connection (a crashed replica) is the backstop,
          // and that is a different event this fake does not model.
        },
      });
    },
  };
  return { db, held, statements, counts: () => ({ reservations, live }) };
}

describe("assertSessionModeUrl", () => {
  test("accepts the direct session-mode connection string", () => {
    expect(() =>
      assertSessionModeUrl("postgresql://postgres:pw@db.ref.supabase.co:5432/postgres"),
    ).not.toThrow();
  });

  // A transaction-mode pooler returns the server connection between
  // statements, so an advisory lock taken through one excludes nothing —
  // with no error anywhere. Refusing the URL is the only visible failure.
  test("refuses a transaction-mode pooler port", () => {
    expect(() =>
      assertSessionModeUrl(
        "postgresql://postgres:pw@aws-0-us-east-2.pooler.supabase.com:6543/postgres",
      ),
    ).toThrow(/TRANSACTION-mode pooler/);
  });

  test("refuses an explicit pgbouncer=true", () => {
    expect(() =>
      assertSessionModeUrl("postgresql://postgres:pw@host:5432/postgres?pgbouncer=true"),
    ).toThrow(/TRANSACTION-mode pooler/);
  });

  test("leaves an unparseable connection string to the driver", () => {
    expect(() => assertSessionModeUrl("not a url")).not.toThrow();
  });
});

describe("createPgSlugLock", () => {
  const logs = captureLogs();

  test("acquires, runs the work, releases the lock and the connection", async () => {
    const { db, held, counts } = fakeAdvisoryDb();
    const lock = createPgSlugLock(db);
    const result = await lock("my-agent", async () => {
      expect(held.has("my-agent")).toBe(true);
      return "done";
    });
    expect(result).toBe("done");
    expect(held.has("my-agent")).toBe(false);
    // A leaked reservation permanently shrinks the admin pool, so the
    // release matters as much as the unlock.
    expect(counts().live).toBe(0);
  });

  test("releases the lock and the connection when the work throws", async () => {
    const { db, held, counts } = fakeAdvisoryDb();
    const lock = createPgSlugLock(db);
    await expect(
      lock("my-agent", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(held.has("my-agent")).toBe(false);
    expect(counts().live).toBe(0);
  });

  test("applies the acquire deadline as a Postgres lock_timeout", async () => {
    const { db, statements } = fakeAdvisoryDb();
    const lock = createPgSlugLock(db, { acquireTimeoutMs: 2500 });
    await lock("my-agent", () => Promise.resolve("ok"));
    // Postgres enforces the deadline and queues the waiter, so there is no
    // poll loop to observe — the `set` is the whole mechanism.
    expect(statements).toContain("set lock_timeout = 2500");
    expect(statements.filter((s) => s.includes("pg_advisory_lock"))).toHaveLength(1);
  });

  test("maps a lock_timeout to SlugLockTimeoutError", async () => {
    const { db } = fakeAdvisoryDb({ timeoutOnContention: true });
    const lock = createPgSlugLock(db, { acquireTimeoutMs: 5 });
    // Another replica holds it: reserve a connection and take the lock.
    const other = await db.reserve();
    await other.query("select pg_advisory_lock($1::int, hashtext($2)::int)", [
      SLUG_LOCK_NAMESPACE,
      "my-agent",
    ]);
    await expect(lock("my-agent", async () => "never")).rejects.toBeInstanceOf(
      SlugLockTimeoutError,
    );
    other.release();
  });

  /**
   * The deadline was unreachable for SAME-replica contention until the mutex
   * gained one. Both slug-lock paths take the in-process mutex FIRST — so a
   * local waiter never reached the Postgres `lock_timeout` that produces this
   * error, and queued on the mutex with no bound at all. Not a rare shape:
   * `watchAgentInvalidation` holds that same mutex across `handoverSlot`,
   * which awaits a replacement sandbox's 120s boot budget, so a redeploy
   * landing while the previous one is still booting is exactly it — and the
   * Modal function timeout is four hours.
   */
  test("a LOCAL waiter times out with the same error, without reaching the database", async () => {
    const { db, counts } = fakeAdvisoryDb();
    const lock = createPgSlugLock(db, { acquireTimeoutMs: 5 });
    const { promise: held, resolve: finish } = Promise.withResolvers<void>();

    // First mutation holds the mutex (and one reserved connection).
    const holder = lock("my-agent", () => held);
    await vi.waitFor(() => expect(counts().live).toBe(1));

    await expect(lock("my-agent", async () => "never")).rejects.toBeInstanceOf(
      SlugLockTimeoutError,
    );
    // It gave up on the MUTEX, so it never reserved a second connection —
    // which is why the mutex is taken first in the first place.
    expect(counts().live).toBe(1);

    finish();
    await holder;
    expect(counts().live).toBe(0);
  });

  test("a local waiter that gives up does not wedge the slug", async () => {
    const { db } = fakeAdvisoryDb();
    const lock = createPgSlugLock(db, { acquireTimeoutMs: 5 });
    const { promise: held, resolve: finish } = Promise.withResolvers<void>();
    const holder = lock("my-agent", () => held);

    await expect(lock("my-agent", async () => "never")).rejects.toBeInstanceOf(
      SlugLockTimeoutError,
    );
    finish();
    await holder;

    // The abandoned waiter released its place in the chain, so the slug is
    // usable again rather than wedged for the life of the process.
    await expect(lock("my-agent", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  test("does not unlock a lock it never acquired", async () => {
    const { db, statements } = fakeAdvisoryDb({ timeoutOnContention: true });
    const lock = createPgSlugLock(db);
    const other = await db.reserve();
    await other.query("select pg_advisory_lock($1::int, hashtext($2)::int)", [
      SLUG_LOCK_NAMESPACE,
      "my-agent",
    ]);
    statements.length = 0;
    await expect(lock("my-agent", async () => "never")).rejects.toBeInstanceOf(
      SlugLockTimeoutError,
    );
    // Unlocking a lock this session never took logs a Postgres warning and
    // returns false — never issue it.
    expect(statements.filter((s) => s.includes("pg_advisory_unlock"))).toHaveLength(0);
    other.release();
  });

  test("serializes in-process waiters on one reservation at a time", async () => {
    const { db, counts } = fakeAdvisoryDb();
    const lock = createPgSlugLock(db);
    const order: string[] = [];
    // Sampled from INSIDE each critical section, which is the only place the
    // reading discriminates. A `setInterval(…, 0)` sampler taking the max was
    // satisfied by taking no samples at all: `peakLive` started at 0 and
    // `toBeLessThanOrEqual(1)` held whether or not the loser ever reserved.
    const live: number[] = [];
    await Promise.all([
      lock("my-agent", async () => {
        order.push("first-start");
        live.push(counts().live);
        await new Promise((resolve) => setImmediate(resolve));
        live.push(counts().live);
        order.push("first-end");
      }),
      lock("my-agent", async () => {
        order.push("second-start");
        live.push(counts().live);
        order.push("second-end");
      }),
    ]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
    // The local mutex is what keeps the loser from holding a reserved
    // connection open while blocked on the same lock — including across the
    // holder's await, which is exactly when it would be queued in Postgres.
    expect(live).toEqual([1, 1, 1]);
    expect(counts().reservations).toBe(2);
  });

  test("different slugs do not block each other", async () => {
    const { db } = fakeAdvisoryDb();
    const lock = createPgSlugLock(db);
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const a = lock("agent-a", () => held);
    await expect(lock("agent-b", async () => "b")).resolves.toBe("b");
    release();
    await a;
  });

  /**
   * The unlock is the real release path, not tidiness: `release()` returns the
   * connection to the pool with its session state intact, so a failed unlock
   * LEAKS the lock onto a pooled connection. Hence the warning — and hence
   * this test pins the leak rather than pretending the release covers it.
   */
  test("a failed unlock warns and still returns the connection", async () => {
    const { db, held } = fakeAdvisoryDb();
    const failing: AdminDb = {
      listen: db.listen,
      async reserve() {
        const reserved = await db.reserve();
        return {
          query: (sql, params) =>
            sql.includes("pg_advisory_unlock")
              ? Promise.reject(new Error("db blip"))
              : reserved.query(sql, params),
          release: () => reserved.release(),
        };
      },
    };
    const lock = createPgSlugLock(failing);
    // The caller's work still succeeds — a release failure must not fail it.
    await expect(lock("my-agent", async () => "ok")).resolves.toBe("ok");
    expect(logs.warns()).not.toHaveLength(0);
    // And the lock is still held, which is exactly why the failure is logged.
    expect(held.has("my-agent")).toBe(true);
  });
});

describe("localSlugLock", () => {
  test("serializes work for the same slug", async () => {
    const order: string[] = [];
    await Promise.all([
      localSlugLock("slug", async () => {
        order.push("first-start");
        await new Promise((resolve) => setImmediate(resolve));
        order.push("first-end");
      }),
      localSlugLock("slug", async () => {
        order.push("second");
      }),
    ]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });
});

describe("createMutationLock", () => {
  /**
   * The lease serializes writers across replicas, but each replica's bundle
   * store is a read-through cache with its own TTL. A mutation that reads
   * through that cache computes its merge from a pre-lock snapshot, so two
   * correctly-serialized secret writes on different replicas still lose one
   * of the two values.
   */
  test("a mutation reads durable state, not this replica's cached view", async () => {
    const storage = createMemoryBlobStorage();
    const secrets = createMemorySecretStore();
    const agents = createMemoryAgentRows();
    // Two replicas over one shared backend, plus a cold reader for the truth.
    const a = createBundleStore(storage, { secrets, agents });
    const b = createBundleStore(storage, { secrets, agents });
    const durableEnv = () => createBundleStore(storage, { secrets, agents }).getEnv("x");

    await a.putAgent({
      slug: "x",
      env: { BASE: "1" },
      worker: "w",
      clientFiles: {},
      credential_hashes: ["h"],
    });

    const lockA = createMutationLock(localSlugLock, a);
    const lockB = createMutationLock(localSlugLock, b);

    // Replica B warms its row cache (any read: page load, WS upgrade).
    expect(await b.getEnv("x")).toEqual({ BASE: "1" });

    // `PUT /x/secret {FOO:1}` lands on replica A.
    await lockA("x", async () => {
      await a.putEnv("x", { ...((await a.getEnv("x")) ?? {}), FOO: "1" });
    });
    // Lease released; `PUT /x/secret {BAR:2}` lands on replica B.
    await lockB("x", async () => {
      await b.putEnv("x", { ...((await b.getEnv("x")) ?? {}), BAR: "2" });
    });

    expect(await durableEnv()).toEqual({ BASE: "1", FOO: "1", BAR: "2" });
  });

  test("still serializes writers for the same slug", async () => {
    const order: string[] = [];
    const lock = createMutationLock(localSlugLock, { invalidate: () => undefined });
    await Promise.all([
      lock("s", async () => {
        order.push("first-start");
        await new Promise((resolve) => setImmediate(resolve));
        order.push("first-end");
      }),
      lock("s", () => {
        order.push("second");
        return Promise.resolve();
      }),
    ]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  test("tolerates a store without invalidate (test doubles)", async () => {
    const lock = createMutationLock(localSlugLock, {});
    expect(await lock("s", () => Promise.resolve("ok"))).toBe("ok");
  });
});
