// Copyright 2026 the AAI authors. MIT license.
/**
 * The pressure reading, whose entire product is a LOG LINE — so that is what
 * these assert.
 *
 * Worth stating because it looks like weak testing and is the opposite here: the
 * module deliberately enforces nothing (`platform-db-pressure.ts` carries why),
 * so its only observable behaviour is which level it writes at and whether the
 * line names the thing an operator has to act on. A spec that checked the
 * returned object and not the level would pass while the one warning this exists
 * to produce was emitted at `debug`.
 */

import { describe, expect, test, vi } from "vitest";
import {
  announcePlatformDbPressure,
  type PlatformDbPressure,
  readPlatformDbPressure,
  rolesAtLimit,
  startPlatformDbPressureSweep,
} from "./platform-db-pressure.ts";
import { captureLogs, fakeAdminDbOver } from "./test-utils.ts";

const logs = captureLogs();

/** A reading, with the fields a case cares about overridden. */
function pressure(over: Partial<PlatformDbPressure> = {}): PlatformDbPressure {
  return { maxConnections: 60, inUse: 20, budgeted: 40, roles: [], ...over };
}

/**
 * Answers the module's three queries off one canned reading.
 *
 * Presence-tested with `in` rather than defaulted with `??`, because the values
 * under test include `null` — which `??` treats as absent, so an earlier draft
 * substituted the healthy default and the null case asserted nothing at all
 * while passing.
 */
function queryFor(opts: {
  maxConnections?: unknown;
  inUse?: unknown;
  roles?: { role: string; limit: number; in_use: number }[];
}) {
  return async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
    if (sql.startsWith("show max_connections")) {
      return [{ max_connections: "maxConnections" in opts ? opts.maxConnections : "60" }] as T[];
    }
    if (sql.includes("count(*)::int as n")) {
      return [{ n: "inUse" in opts ? opts.inUse : 20 }] as T[];
    }
    return (opts.roles ?? []) as T[];
  };
}

describe("readPlatformDbPressure", () => {
  test("reports the instance, the fleet claim, and every app role", async () => {
    const p = await readPlatformDbPressure(
      queryFor({
        roles: [
          { role: "app_0123456789abcdef", limit: 10, in_use: 6 },
          { role: "app_fedcba9876543210", limit: 4, in_use: 0 },
        ],
      }),
      { PLATFORM_POOLER_URL: "postgresql://x@pool:6543/db" },
    );
    expect(p.maxConnections).toBe(60);
    expect(p.inUse).toBe(20);
    expect(p.budgeted).toBe(40);
    // A provisioned role with NO live backend is a row worth having — it is what
    // makes "how many apps are actually active" answerable, and an inner join
    // would have dropped exactly those.
    expect(p.roles).toEqual([
      { role: "app_0123456789abcdef", inUse: 6, limit: 10 },
      { role: "app_fedcba9876543210", inUse: 0, limit: 4 },
    ]);
  });

  test("reads max_connections POSITIONALLY, whatever the column is called", async () => {
    // `show` names its column after the setting; a version that aliases it
    // differently must not silently yield NaN.
    const query = async <T>(sql: string): Promise<T[]> =>
      (sql.startsWith("show") ? [{ some_other_name: "97" }] : [{ n: 3 }]) as T[];
    expect((await readPlatformDbPressure(query)).maxConnections).toBe(97);
  });

  test("THROWS on an unreadable answer rather than reporting a plausible zero", async () => {
    // A reading that silently becomes 0/0 is the failure mode this module exists
    // to replace, so it may not invent one.
    await expect(
      readPlatformDbPressure(queryFor({ maxConnections: "not-a-number" })),
    ).rejects.toThrow(/Unreadable pressure/);
    // `null` specifically: `Number(null)` is 0, so a bare coercion would report
    // a perfectly plausible "nothing is connected" for an unreadable column.
    await expect(readPlatformDbPressure(queryFor({ inUse: null }))).rejects.toThrow(
      /Unreadable pressure/,
    );
    await expect(readPlatformDbPressure(queryFor({ maxConnections: null }))).rejects.toThrow(
      /Unreadable pressure/,
    );
  });

  /**
   * The role filter is a REGEX on the identifier grammar, not a `like 'app\_%'`
   * — `_` is a LIKE wildcard, so the escaped form is one backslash away from
   * matching `appXsomething` and the escape is invisible in review.
   */
  test("selects app roles by the anchored identifier grammar", async () => {
    const seen: string[] = [];
    await readPlatformDbPressure(async <T>(sql: string): Promise<T[]> => {
      seen.push(sql);
      return (sql.startsWith("show") ? [{ m: "60" }] : [{ n: 1 }]) as T[];
    });
    const roleQuery = seen.find((s) => s.includes("pg_roles"));
    expect(roleQuery).toContain("^app_[0-9a-f]{16}$");
    expect(roleQuery).not.toContain("like");
    // A LEFT JOIN, so a provisioned role with no backend still appears.
    expect(roleQuery).toContain("left join");
  });
});

describe("rolesAtLimit", () => {
  test("finds roles already being refused", () => {
    const at = rolesAtLimit(
      pressure({
        roles: [
          { role: "app_a".padEnd(20, "0"), inUse: 10, limit: 10 },
          { role: "app_b".padEnd(20, "0"), inUse: 3, limit: 10 },
        ],
      }),
    );
    expect(at.map((r) => r.inUse)).toEqual([10]);
  });

  test("a role with NO limit can never be at one", () => {
    // `-1` is Postgres for unlimited. Provisioning always sets a limit, so this
    // is a role predating that or altered by hand — not a saturated one.
    expect(
      rolesAtLimit(pressure({ roles: [{ role: "app_x".padEnd(20, "0"), inUse: 99, limit: -1 }] })),
    ).toEqual([]);
  });
});

describe("announcePlatformDbPressure", () => {
  test("a healthy instance is DEBUG, not a line every tick", () => {
    // A warning an operator cannot clear teaches them to filter the channel,
    // and this is the channel that carries the one that matters.
    announcePlatformDbPressure(pressure({ inUse: 20 }));
    expect(logs.warns()).toEqual([]);
    expect(logs.infos()).toEqual([]);
  });

  test("warns past the instance threshold, naming the failure it precedes", () => {
    announcePlatformDbPressure(pressure({ inUse: 50 }));
    expect(logs.warns()).toHaveLength(1);
    const line = logs.warns()[0] ?? "";
    expect(line).toContain("83%");
    // The operator-facing point: platform reads fail BEFORE any tenant notices.
    expect(line).toContain("remaining connection slots are reserved");
  });

  /**
   * The two triggers are INDEPENDENT, and this is the one a fraction cannot
   * express: an instance at 33% with one tenant at its ceiling is a tenant
   * already being refused, and the response (its tier, or its bug) is nothing
   * like the response to a full instance.
   */
  test("warns for a role at its own limit even on a quiet instance", () => {
    announcePlatformDbPressure(
      pressure({
        inUse: 20,
        roles: [{ role: "app_0123456789abcdef", inUse: 4, limit: 4 }],
      }),
    );
    const line = logs.warns()[0] ?? "";
    expect(line).toContain("app_0123456789abcdef=4/4");
    expect(line).toContain("too many connections for role");
    // And it names the remedy, so the warning is self-correcting.
    expect(line).toContain("--tier workflow");
  });

  test("names only the busiest few roles, never a kilobyte of them", () => {
    announcePlatformDbPressure(
      pressure({
        roles: Array.from({ length: 40 }, (_, i) => ({
          role: `app_${String(i).padStart(16, "0")}`,
          inUse: 1,
          limit: 10,
        })),
      }),
    );
    // Healthy, so this is the debug line — assert via `all()` since level
    // filtering is the point of the case above, not this one.
    const line = logs.all().at(-1)?.msg ?? "";
    expect(line).toContain("40 of 40 app role(s) connected");
    expect(line.match(/app_0/g) ?? []).toHaveLength(3);
  });
});

describe("startPlatformDbPressureSweep", () => {
  test("does nothing without a platform database, and says so quietly", () => {
    const stop = startPlatformDbPressureSweep({});
    expect(logs.warns()).toEqual([]);
    expect(logs.infos()).toEqual([]);
    expect(stop).not.toThrow();
  });

  test("interval 0 is the documented kill switch, and is announced", () => {
    const stop = startPlatformDbPressureSweep({
      adminDb: fakeAdminDbOver(() => []),
      intervalMs: 0,
    });
    // `info`, not debug: an operator who set this is reading the log to confirm
    // it took.
    expect(logs.infos().join(" ")).toContain("interval is 0");
    stop();
  });

  test("takes a leader lock, and a lost lock reads nothing", async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const adminDb = fakeAdminDbOver((sql) => {
        seen.push(sql);
        // Another replica holds this tick.
        if (sql.includes("pg_try_advisory_xact_lock")) return [{ locked: false }];
        return [];
      });
      const stop = startPlatformDbPressureSweep({ adminDb, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      stop();
      expect(seen.some((s) => s.includes("pg_try_advisory_xact_lock"))).toBe(true);
      // The reading itself never ran, which is what "a lost lock is a silent
      // skip" has to mean — five replicas would otherwise log five identical
      // lines for one fleet-wide number.
      expect(seen.some((s) => s.startsWith("show max_connections"))).toBe(false);
      expect(logs.warns()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the leader reads and announces, and RELEASES its connection", async () => {
    vi.useFakeTimers();
    try {
      const adminDb = fakeAdminDbOver((sql) => {
        if (sql.includes("pg_try_advisory_xact_lock")) return [{ locked: true }];
        if (sql.startsWith("show max_connections")) return [{ max_connections: "60" }];
        if (sql.includes("count(*)::int as n")) return [{ n: 55 }];
        return [];
      });
      const stop = startPlatformDbPressureSweep({ adminDb, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      stop();
      expect(logs.warns().join(" ")).toContain("92%");
      // A leaked reservation permanently shrinks the pool, which is why the
      // release is in a `finally` and why this asserts it.
      expect(adminDb.release).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed reading is reported and never kills the replica", async () => {
    vi.useFakeTimers();
    try {
      const adminDb = fakeAdminDbOver((sql) => {
        if (sql.includes("pg_try_advisory_xact_lock")) return [{ locked: true }];
        throw new Error("connection reset");
      });
      const stop = startPlatformDbPressureSweep({ adminDb, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      stop();
      expect(logs.warns().join(" ")).toContain("pressure reading failed");
      // Released even on the failure path.
      expect(adminDb.release).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
