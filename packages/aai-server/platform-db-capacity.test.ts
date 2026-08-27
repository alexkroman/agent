// Copyright 2026 the AAI authors. MIT license.
/**
 * The boot-time capacity check. Its whole output is a log line, which is the
 * shape of thing that fails silently — a reading that stopped working, or an
 * inequality the wrong way round, looks exactly like a healthy instance. So
 * both verdicts are asserted, and so is the arithmetic inside the message: the
 * numbers are the only actionable part of the warning.
 */
import { describe, expect, test, vi } from "vitest";
import { MAX_PLATFORM_DB_CONNECTIONS } from "./constants.ts";
import {
  announcePlatformDbCapacity,
  platformDbBudget,
  readPlatformDbCapacity,
} from "./platform-db-capacity.ts";
import type { SqlExec } from "./secret-store.ts";
import { captureLogs } from "./test-utils.ts";

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
/**
 * The two routings of the ADMIN pool, which is the one term
 * {@link MAX_PLATFORM_DB_CONNECTIONS} excludes — and it excludes it on a
 * PREMISE, so every reading here has to say which arm it is about.
 *
 * `POOLED` is the configuration the constants were sized for: Supavisor in
 * transaction mode really does multiplex, so the pool costs the instance
 * nothing and the budget is exactly the constant. `DIRECT` is what production
 * was actually running — `PLATFORM_POOLER_URL` unset — where every replica
 * opens `ADMIN_POOL_MAX` real backends.
 */
const POOLED = { PLATFORM_POOLER_URL: "postgresql://u@pool.example:6543/db" };
const DIRECT = { MAX_CONTAINERS: "5" };
const logged = (read: () => readonly unknown[]): Promise<void> =>
  vi.waitFor(() => {
    // A throw is how `vi.waitFor` is told to retry. Deliberately not an
    // `expect` — biome's `noMisplacedAssertion` rejects one outside a test
    // body, and it is right to: an assertion in a helper reports against
    // whichever test happens to await it.
    if (read().length === 0) throw new Error("nothing logged yet");
  });
describe("platformDbBudget", () => {
  test("claims the constant rather than re-deriving a sum", () => {
    expect(platformDbBudget(POOLED)).toBe(MAX_PLATFORM_DB_CONNECTIONS);
  });
  /**
   * There WAS a second spec here, pinning a production regression: the budget had
   * been `MAX_PLATFORM_DB_CONNECTIONS + APP_DB_CONNECTION_ALLOWANCE` — the app
   * databases added to a constant that already contained them — which overstated
   * the claim by exactly the allowance, put it at 60 on an instance whose
   * `max_connections` is 60, and made the overrun warning fire on all 7 boots of
   * one production day.
   *
   * It cannot be double-counted any more because there is no allowance: every
   * connection in the budget is the platform's own. The spec above is what remains
   * of it — the budget IS the constant — and it is the assertion that would still
   * catch a term being added back on top.
   */
  /**
   * The production reading itself, as a case: `max_connections=60` with the ~17
   * backends Supabase's own Realtime / PostgREST / Storage workers hold at idle
   * is the instance this runs on, and it is the reading the warning fired over.
   * It has to FIT, or the check is back to warning about the shape of the fleet
   * rather than about the fleet.
   */
  test("fits the provisioned instance at its measured idle load", () => {
    expect(platformDbBudget(POOLED) + 17).toBeLessThanOrEqual(60);
  });
  /**
   * The arm production was on, and the reason the check needed an env at all.
   *
   * `MAX_PLATFORM_DB_CONNECTIONS` excludes the admin pool because the pool is
   * POOLED — true only with `PLATFORM_POOLER_URL` set, and it was not. So the
   * fleet claim was `40 + 5 x 4 = 60` against `max_connections=60` with 20
   * already held by Supabase's own workers, and boot printed
   * `capacity ok — 0 spare` one line under the warning naming those four per
   * replica. Both numbers logged, neither compared; the 53300 exhaustion they
   * predict arrived with no warning at all.
   *
   * This asserts the OVERRUN rather than a fit, because the overrun is the
   * truth about that configuration: no constant here can absorb 20 more
   * connections on a 60-connection instance, so the fix is the pooler URL (or
   * a bigger instance) and the code's job is to say so at boot.
   */
  test("the DIRECT arm overruns the provisioned instance, which is the finding", () => {
    expect(platformDbBudget(DIRECT)).toBeGreaterThan(platformDbBudget(POOLED));
    expect(platformDbBudget(DIRECT) + 20).toBeGreaterThan(60);
  });
});
describe("readPlatformDbCapacity", () => {
  test("headroom is what the instance has left after everyone else and us", async () => {
    const c = await readPlatformDbCapacity(fakeSql(200, 17), POOLED);
    expect(c.maxConnections).toBe(200);
    expect(c.inUse).toBe(17);
    expect(c.budgeted).toBe(platformDbBudget(POOLED));
    expect(c.headroom).toBe(200 - 17 - platformDbBudget(POOLED));
  });
  test("headroom goes NEGATIVE when the budget overruns the instance", async () => {
    // Derived from the budget rather than written as a literal pair. This was
    // `fakeSql(60, 17)` — the real provisioned instance at its real idle load —
    // which the double-counted budget made negative and the corrected one does
    // not, so the test asserted the bug. Anything past the budget's own headroom
    // overruns whatever the budget happens to be.
    const c = await readPlatformDbCapacity(fakeSql(60, 60 - platformDbBudget(POOLED) + 1), POOLED);
    expect(c.headroom).toBeLessThan(0);
  });
  /**
   * The other side of that pair, and the one the old literal hid: the instance
   * this actually runs on, at the idle load actually measured on it, must come
   * out POSITIVE. Without this the check can regress to warning unconditionally
   * again and every test above it still passes.
   */
  test("headroom stays positive on the provisioned instance at idle", async () => {
    const c = await readPlatformDbCapacity(fakeSql(60, 17), POOLED);
    expect(c.headroom).toBeGreaterThanOrEqual(0);
  });
  test("the SAME reading is negative once the admin pool is direct", async () => {
    // One reading, two verdicts, and the difference is a variable nothing in
    // the arithmetic used to read. This is the pair: the check is now sensitive
    // to how the pool is ROUTED, which is what it has to be for the "ok" above
    // to mean anything.
    const c = await readPlatformDbCapacity(fakeSql(60, 17), DIRECT);
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
  const logs = captureLogs();
  test("warns with the arithmetic when the budget overruns the instance", async () => {
    // A reading that really overruns: the budget plus this much other load is
    // past 60. Deliberately NOT the (60, 17) production reading this used to
    // use — that one FITS now (see `platformDbBudget` above), and a warning
    // asserted against a fitting reading is how the double count stayed green.
    const inUse = 60 - platformDbBudget(POOLED) + 5;
    announcePlatformDbCapacity(fakeSql(60, inUse), POOLED);
    await logged(logs.warns);
    expect(logs.infos()).toEqual([]);
    const message = String(logs.warns()[0]);
    expect(message).toContain("OVERRUNS");
    // By how much, and out of what — a warning without the numbers is not
    // actionable, and the overrun is the only number an operator can act on.
    expect(message).toContain(`${platformDbBudget(POOLED) + inUse - 60}`);
    expect(message).toContain("max_connections=60");
    expect(message).toContain(`in use at boot=${inUse}`);
    expect(message).toContain("MAX_CONTAINERS");
  });
  test("reports the spare capacity when the budget fits", async () => {
    announcePlatformDbCapacity(fakeSql(500, 20), POOLED);
    await logged(logs.infos);
    expect(logs.warns()).toEqual([]);
    expect(String(logs.infos()[0])).toContain(`${500 - 20 - platformDbBudget(POOLED)} spare`);
    // A term that costs nothing is left out of a line somebody reads at boot.
    expect(String(logs.infos()[0])).not.toContain("PLATFORM_POOLER_URL");
  });
  test("names the DIRECT admin pool in the arithmetic, and the remedy", async () => {
    // The half that made the production line unreadable: the connections were
    // announced by a DIFFERENT log site, so the number and the budget it was
    // missing from never appeared together. Naming the variable is what makes
    // the warning actionable — the alternative remedies (fewer containers, a
    // bigger instance) are already in the sentence.
    announcePlatformDbCapacity(fakeSql(500, 20), DIRECT);
    await logged(logs.infos);
    const message = String(logs.infos()[0]);
    expect(message).toContain("DIRECT admin pools");
    expect(message).toContain("PLATFORM_POOLER_URL");
    expect(message).toContain(`platform budget=${platformDbBudget(DIRECT)}`);
  });
  test("a failed reading warns instead of rejecting into the boot path", async () => {
    const failing: SqlExec = () => Promise.reject(new Error("connection refused"));
    // Fire-and-forget: the contract is that it returns void and never throws,
    // because boot must not be able to fail on a projection.
    expect(announcePlatformDbCapacity(failing)).toBeUndefined();
    await logged(logs.warns);
    expect(String(logs.warns()[0])).toContain("could not read");
  });
});
