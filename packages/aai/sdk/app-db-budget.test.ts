// Copyright 2026 the AAI authors. MIT license.
/**
 * The pool sizes a guest uses against a database it was GIVEN.
 *
 * This suite used to assert an ENTITLEMENT: that the sums here matched the
 * `connection limit` the platform provisioned for each app's role, because a
 * mismatch meant a guest was refused a connection it had been promised. The
 * platform provisions no databases now, so those assertions went with the
 * functions they checked.
 *
 * What is left is the one relationship between two of the numbers — and it is the
 * one that was a FIX rather than a preference, so it is the one worth pinning.
 */

import { describe, expect, test } from "vitest";
import { APP_DB_WORLD_POOL_MAX, APP_DB_WORLD_WORKER_CONCURRENCY } from "./app-db-budget.ts";

describe("the DevKit world's pool", () => {
  test("step concurrency is DERIVED one below the world pool", () => {
    // graphile-worker takes one of the pool's connections and holds it for the life
    // of the process to `LISTEN` for `jobs:insert` (verified in graphile-worker
    // 0.16.6: `pgPool.connect(listenForChanges)`, released only on shutdown). A
    // concurrency equal to the pool therefore leaves its last worker waiting on a
    // pool that has nothing to give — which reads as a hung run, and was the
    // situation this correction came out of.
    expect(APP_DB_WORLD_WORKER_CONCURRENCY).toBe(APP_DB_WORLD_POOL_MAX - 1);
    expect(APP_DB_WORLD_WORKER_CONCURRENCY).toBeGreaterThan(0);
  });

  test("the pool is smaller than node-postgres's default of 10", () => {
    // The reason it is pinned at all: the library default assumes it owns the
    // database, and on the surviving paths this one is the AUTHOR's, shared with
    // whatever else they point at it.
    expect(APP_DB_WORLD_POOL_MAX).toBeLessThan(10);
  });
});
