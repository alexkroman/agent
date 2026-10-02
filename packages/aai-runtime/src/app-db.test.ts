// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the leased app-database pool.
 *
 * A fake `createPostgresDb` is handed in, so nothing here opens a connection: what matters
 * is HOW MANY pools are built for a URL and when the last lease closes one —
 * which is the whole property, the guest's connection budget being a count of
 * pools rather than of callers.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { APP_DB_POOL_MAX, openAppDb as openRealAppDb } from "./app-db.ts";

const close = vi.fn(() => Promise.resolve());
const query = vi.fn(() => Promise.resolve([]));
const reserve = vi.fn(() => Promise.resolve({ query, release: () => undefined }));
const listen = vi.fn(() => Promise.resolve(() => undefined));
const createPostgresDb = vi.fn((_options: { url: string; max: number }) => ({
  query,
  reserve,
  listen,
  close,
}));

/** {@link openRealAppDb} over the fake pool factory. */
const openAppDb = (url: string) => openRealAppDb(url, createPostgresDb);

/** A URL nothing else in this file uses, so the process-wide registry cannot leak between tests. */
let next = 0;
function freshUrl(): string {
  next += 1;
  return `postgres://user:pw@127.0.0.1:1/app-db-spec-${next}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("openAppDb", () => {
  test("builds one pool per url, at the budget's size, however many leases are taken", async () => {
    const url = freshUrl();
    const first = openAppDb(url);
    const second = openAppDb(url);

    expect(createPostgresDb).toHaveBeenCalledExactlyOnceWith({ url, max: APP_DB_POOL_MAX });
    // Both leases really are the same pool, which is the point of sharing them.
    await first.query("select 1");
    await second.query("select 2");
    expect(query).toHaveBeenCalledTimes(2);
  });

  test("a second url is a second pool — the registry is keyed, not global", () => {
    openAppDb(freshUrl());
    openAppDb(freshUrl());
    expect(createPostgresDb).toHaveBeenCalledTimes(2);
  });

  test("the pool closes with the LAST lease, not the first", async () => {
    const url = freshUrl();
    const first = openAppDb(url);
    const second = openAppDb(url);

    await first.close();
    // The whole reason each caller's own `close()` stays correct: releasing one
    // lease must not drop the pool out from under the runtime still using it.
    expect(close).not.toHaveBeenCalled();

    await second.close();
    expect(close).toHaveBeenCalledOnce();
  });

  test("closing a lease twice releases it once", async () => {
    const url = freshUrl();
    const first = openAppDb(url);
    const second = openAppDb(url);

    await first.close();
    await first.close();
    expect(close).not.toHaveBeenCalled();

    await second.close();
    expect(close).toHaveBeenCalledOnce();
  });

  test("a lease taken after the last one closed opens a fresh pool", async () => {
    const url = freshUrl();
    await openAppDb(url).close();
    expect(close).toHaveBeenCalledOnce();

    const revived = openAppDb(url);
    expect(createPostgresDb).toHaveBeenCalledTimes(2);
    await revived.query("select 1");
    expect(query).toHaveBeenCalledOnce();
  });

  test("reserve reaches the shared pool, so a reservation is charged to it", async () => {
    const lease = openAppDb(freshUrl());
    const held = await lease.reserve();
    expect(reserve).toHaveBeenCalledOnce();
    held.release();
  });
});
