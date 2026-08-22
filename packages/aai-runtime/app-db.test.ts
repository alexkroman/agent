// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the leased app-database pool.
 *
 * `createPostgresDb` is mocked, so nothing here opens a connection: what matters
 * is HOW MANY pools are built for a URL and when the last lease closes one —
 * which is the whole property, the guest's connection budget being a count of
 * pools rather than of callers.
 */

import { APP_DB_POOL_MAX } from "@alexkroman1/aai/host-internal";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { openAppDb } from "./app-db.ts";

const close = vi.fn(() => Promise.resolve());
const query = vi.fn(() => Promise.resolve([]));
const reserve = vi.fn(() => Promise.resolve({ query, release: () => undefined }));
const createPostgresDb = vi.fn(() => ({ query, reserve, close }));

vi.mock("./postgres-db.ts", () => ({
  createPostgresDb: (...args: unknown[]) => createPostgresDb(...(args as [])),
}));

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

  test("a SECOND copy of this module shares the registry, which is the whole point", async () => {
    // A deployed agent's bundle carries its own copy of the SDK, so the runtime's
    // `openAppDb` and the harness's are two module instances in one realm — the
    // reason the registry is a `Symbol.for` on `globalThis` rather than a
    // module-level `Map`. A query-suffixed import is a separate instance here for
    // the same reason it would be there: a different module identity.
    // The specifier goes through a variable because `tsc` resolves a literal one
    // and there is no such FILE — the query suffix is a module-identity trick the
    // runner understands and the type checker rightly does not.
    const secondCopy = "./app-db.ts?second-copy";
    const other = (await import(secondCopy)) as { openAppDb: typeof openAppDb };
    expect(other.openAppDb).not.toBe(openAppDb);

    const url = freshUrl();
    const mine = openAppDb(url);
    const theirs = other.openAppDb(url);
    expect(createPostgresDb).toHaveBeenCalledOnce();

    await mine.close();
    expect(close).not.toHaveBeenCalled();
    await theirs.close();
    expect(close).toHaveBeenCalledOnce();
  });

  test("reserve reaches the shared pool, so a reservation is charged to it", async () => {
    const lease = openAppDb(freshUrl());
    const held = await lease.reserve();
    expect(reserve).toHaveBeenCalledOnce();
    held.release();
  });
});
