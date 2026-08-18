// Copyright 2026 the AAI authors. MIT license.
/**
 * The boot-time capacity check. Its whole output is a log line, which is the
 * shape of thing that fails silently — a reading that stopped working, or an
 * inequality the wrong way round, looks exactly like a healthy instance. So
 * both verdicts are asserted, and so is the arithmetic inside the message: the
 * numbers are the only actionable part of the warning.
 */

import { describe, expect, type MockInstance, test, vi } from "vitest";
import {
  APP_DB_CONNECTION_LIMIT,
  MAX_ACTIVE_APP_DATABASES,
  MAX_PLATFORM_DB_CONNECTIONS,
} from "./constants.ts";
import {
  announcePlatformDbCapacity,
  platformDbBudget,
  readPlatformDbCapacity,
} from "./platform-db-capacity.ts";
import type { SqlExec } from "./secret-store.ts";

/**
 * A `SqlExec` that answers the two reads by SHAPE rather than by call order.
 * Order-keyed fakes pass just as well when the two queries are swapped, which
 * is the one bug a two-query reading can have.
 */
function fakeSql(maxConnections: unknown, inUse: unknown): SqlExec {
  return (query) => {
    if (query.startsWith("show")) return Promise.resolve([{ max_connections: maxConnections }]);
    return Promise.resolve([{ n: inUse }]);
  };
}

/**
 * `announce*` is fire-and-forget over a two-query read, so the log lands several
 * microtasks later — `vi.waitFor` rather than a fixed number of yields, which is
 * a count that goes stale the moment the read gains an await.
 */
const logged = (spy: MockInstance): Promise<void> =>
  vi.waitFor(() => {
    // A throw is how `vi.waitFor` is told to retry. Deliberately not an
    // `expect` — biome's `noMisplacedAssertion` rejects one outside a test
    // body, and it is right to: an assertion in a helper reports against
    // whichever test happens to await it.
    if (spy.mock.calls.length === 0) throw new Error("nothing logged yet");
  });

describe("platformDbBudget", () => {
  test("counts the app databases the direct budget cannot reach", () => {
    expect(platformDbBudget()).toBe(
      MAX_PLATFORM_DB_CONNECTIONS + MAX_ACTIVE_APP_DATABASES * APP_DB_CONNECTION_LIMIT,
    );
    // The correction this module exists for: strictly MORE than the direct
    // budget alone, because session-mode pooling multiplexes nothing.
    expect(platformDbBudget()).toBeGreaterThan(MAX_PLATFORM_DB_CONNECTIONS);
  });
});

describe("readPlatformDbCapacity", () => {
  test("headroom is what the instance has left after everyone else and us", async () => {
    const c = await readPlatformDbCapacity(fakeSql(200, 17));
    expect(c.maxConnections).toBe(200);
    expect(c.inUse).toBe(17);
    expect(c.budgeted).toBe(platformDbBudget());
    expect(c.headroom).toBe(200 - 17 - platformDbBudget());
  });

  test("headroom goes NEGATIVE when the budget overruns the instance", async () => {
    // The provisioned shape this was written for: a 60-connection instance with
    // Supabase's own workers already on it.
    const c = await readPlatformDbCapacity(fakeSql(60, 17));
    expect(c.headroom).toBeLessThan(0);
  });

  test("reads `show max_connections` positionally, not by column name", async () => {
    // A Postgres version that aliases the column differently must not yield NaN.
    const sql: SqlExec = (query) =>
      query.startsWith("show")
        ? Promise.resolve([{ some_other_alias: 120 }])
        : Promise.resolve([{ n: 4 }]);
    await expect(readPlatformDbCapacity(sql)).resolves.toMatchObject({ maxConnections: 120 });
  });

  test("throws rather than reporting NaN when a reading is unusable", async () => {
    await expect(readPlatformDbCapacity(fakeSql("not-a-number", 4))).rejects.toThrow(
      /Unreadable capacity/,
    );
    await expect(readPlatformDbCapacity(fakeSql(60, undefined))).rejects.toThrow(
      /Unreadable capacity/,
    );
  });
});

describe("announcePlatformDbCapacity", () => {
  test("warns with the arithmetic when the budget overruns the instance", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    announcePlatformDbCapacity(fakeSql(60, 17));
    await logged(warn);

    expect(info).not.toHaveBeenCalled();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("OVERRUNS");
    // By how much, and out of what — a warning without the numbers is not
    // actionable, and the overrun is the only number an operator can act on.
    expect(message).toContain(`${platformDbBudget() + 17 - 60}`);
    expect(message).toContain("max_connections=60");
    expect(message).toContain("in use at boot=17");
    expect(message).toContain("MAX_CONTAINERS");
  });

  test("reports the spare capacity when the budget fits", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    announcePlatformDbCapacity(fakeSql(500, 20));
    await logged(info);

    expect(warn).not.toHaveBeenCalled();
    expect(String(info.mock.calls[0]?.[0])).toContain(`${500 - 20 - platformDbBudget()} spare`);
  });

  test("a failed reading warns instead of rejecting into the boot path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing: SqlExec = () => Promise.reject(new Error("connection refused"));

    // Fire-and-forget: the contract is that it returns void and never throws,
    // because boot must not be able to fail on a projection.
    expect(announcePlatformDbCapacity(failing)).toBeUndefined();
    await logged(warn);

    expect(String(warn.mock.calls[0]?.[0])).toContain("Could not read");
  });
});
