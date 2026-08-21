// Copyright 2026 the AAI authors. MIT license.
/**
 * The budget's own arithmetic. What it is checked AGAINST — the app role's
 * `connection limit` — lives in `aai-server/platform-db-budget.test.ts`, since
 * this package may not import the platform's constants.
 */

import { describe, expect, test } from "vitest";
import {
  APP_DB_BOOT_SPARE,
  APP_DB_POOL_MAX,
  APP_DB_PRESENCE_LOCK,
  APP_DB_WORLD_LISTEN,
  APP_DB_WORLD_POOL_MAX,
  APP_DB_WORLD_WORKER_CONCURRENCY,
  guestAppDbConnections,
} from "./app-db-budget.ts";

describe("guestAppDbConnections", () => {
  test("counts every consumer, so a new one cannot be added without the sum moving", () => {
    expect(guestAppDbConnections()).toBe(
      APP_DB_WORLD_POOL_MAX + APP_DB_WORLD_LISTEN + APP_DB_POOL_MAX + APP_DB_PRESENCE_LOCK,
    );
  });

  test("the boot spare is headroom, not a consumer, so it is NOT in the sum", () => {
    // It is what the role's limit must exceed the ceiling BY. Counting it as a
    // consumer would let the ceiling grow into the very headroom that covers a
    // redeploy's overlap.
    expect(guestAppDbConnections()).toBeGreaterThan(APP_DB_BOOT_SPARE);
  });

  test("step concurrency is DERIVED one below the world pool", () => {
    // graphile-worker holds one of the pool's connections for the life of the
    // process to LISTEN for `jobs:insert`, so a concurrency equal to the pool
    // leaves its last worker waiting on a pool that has nothing to give.
    expect(APP_DB_WORLD_WORKER_CONCURRENCY).toBe(APP_DB_WORLD_POOL_MAX - 1);
    expect(APP_DB_WORLD_WORKER_CONCURRENCY).toBeGreaterThan(0);
  });

  test("the spare is real, so the boot migration is not competing with a resident", () => {
    expect(APP_DB_BOOT_SPARE).toBeGreaterThan(0);
  });
});
