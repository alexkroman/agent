// Copyright 2026 the AAI authors. MIT license.

import { createStorage } from "unstorage";
import { describe, expect, test } from "vitest";
import { createMemoryAgentRows } from "./agent-store.ts";
import { createBundleStore } from "./bundle-store.ts";
import {
  createMutationLock,
  createPgSlugLock,
  localSlugLock,
  SlugLockTimeoutError,
} from "./platform-lock.ts";
import { createMemorySecretStore, type SqlExec } from "./secret-store.ts";
import { TEST_AGENT_CONFIG } from "./test-utils.ts";

/**
 * Fake `SqlExec` reproducing the lease-table semantics of the lock's two
 * statements (insert-or-take-over-when-expired, delete-if-mine) over an
 * in-memory map with an injectable clock — exercising the acquire/poll/
 * release logic without a real database.
 */
function fakeLeaseDb(clock: { now: number }) {
  const leases = new Map<string, { holder: string; expiresAt: number }>();
  const statements: string[] = [];
  const exec: SqlExec = (query, params) => {
    statements.push(query);
    if (query.startsWith("create")) return Promise.resolve([]);
    if (query.startsWith("delete")) {
      const [key, holder] = params as [string, string];
      if (leases.get(key)?.holder === holder) leases.delete(key);
      return Promise.resolve([]);
    }
    // The acquire upsert.
    const [key, holder, leaseMs] = params as [string, string, number];
    const existing = leases.get(key);
    if (existing && existing.expiresAt > clock.now) return Promise.resolve([]);
    leases.set(key, { holder, expiresAt: clock.now + leaseMs });
    return Promise.resolve([{ holder }]);
  };
  return { exec, leases, statements };
}

describe("createPgSlugLock", () => {
  test("acquires, runs the work, and releases the lease", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeLeaseDb(clock);
    const lock = createPgSlugLock(db.exec);
    const result = await lock("my-agent", async () => {
      expect(db.leases.has("my-agent")).toBe(true);
      return "done";
    });
    expect(result).toBe("done");
    expect(db.leases.has("my-agent")).toBe(false);
  });

  test("releases the lease when the work throws", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeLeaseDb(clock);
    const lock = createPgSlugLock(db.exec);
    await expect(
      lock("my-agent", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(db.leases.has("my-agent")).toBe(false);
  });

  test("waits for a contended lease and proceeds once it is released", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeLeaseDb(clock);
    const lock = createPgSlugLock(db.exec, { pollMs: 1, acquireTimeoutMs: 1000 });
    // Simulate another replica's live lease.
    db.leases.set("my-agent", { holder: "other-replica", expiresAt: clock.now + 60_000 });
    const order: string[] = [];
    const pending = lock("my-agent", async () => {
      order.push("ran");
    });
    // Give the acquirer a few polls against the held lease, then release it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    db.leases.delete("my-agent");
    await pending;
    expect(order).toEqual(["ran"]);
  });

  test("takes over an expired lease from a crashed holder", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeLeaseDb(clock);
    const lock = createPgSlugLock(db.exec, { pollMs: 1 });
    db.leases.set("my-agent", { holder: "crashed-replica", expiresAt: clock.now - 1 });
    await expect(lock("my-agent", async () => "ok")).resolves.toBe("ok");
    expect(db.leases.has("my-agent")).toBe(false);
  });

  test("times out with SlugLockTimeoutError when the lease never frees", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeLeaseDb(clock);
    const lock = createPgSlugLock(db.exec, { pollMs: 1, acquireTimeoutMs: 5 });
    db.leases.set("my-agent", { holder: "other-replica", expiresAt: clock.now + 60_000 });
    await expect(lock("my-agent", async () => "never")).rejects.toBeInstanceOf(
      SlugLockTimeoutError,
    );
  });

  test("serializes in-process waiters without burning database polls", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeLeaseDb(clock);
    const lock = createPgSlugLock(db.exec, { pollMs: 1 });
    const order: string[] = [];
    await Promise.all([
      lock("my-agent", async () => {
        order.push("first-start");
        await new Promise((resolve) => setImmediate(resolve));
        order.push("first-end");
      }),
      lock("my-agent", async () => {
        order.push("second-start");
        order.push("second-end");
      }),
    ]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
    // The second waiter queued on the local mutex, then acquired a free
    // lease first try — no contention polls hit the database.
    const acquires = db.statements.filter((s) => s.startsWith("insert")).length;
    expect(acquires).toBe(2);
  });

  test("different slugs do not block each other", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeLeaseDb(clock);
    const lock = createPgSlugLock(db.exec, { pollMs: 1 });
    let aRelease: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      aRelease = resolve;
    });
    const a = lock("agent-a", () => held);
    await expect(lock("agent-b", async () => "b")).resolves.toBe("b");
    aRelease?.();
    await a;
  });

  test("a failed release leaves the lease to expire without failing the work", async () => {
    const clock = { now: 1_000_000 };
    const db = fakeLeaseDb(clock);
    const exec: SqlExec = (query, params) =>
      query.startsWith("delete") ? Promise.reject(new Error("db blip")) : db.exec(query, params);
    const lock = createPgSlugLock(exec);
    await expect(lock("my-agent", async () => "ok")).resolves.toBe("ok");
    expect(db.leases.has("my-agent")).toBe(true); // expires on its own
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
    const storage = createStorage();
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
      agentConfig: TEST_AGENT_CONFIG,
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
