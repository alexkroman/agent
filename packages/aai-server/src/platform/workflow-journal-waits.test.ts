// Copyright 2026 the AAI authors. MIT license.
/**
 * The wait statements, against a recorder. Moved from `workflow-journal.test.ts`;
 * the slug-in-every-statement and one-statement-claim invariants stay there,
 * because they are asserted over the whole journal surface at once.
 */

import { describe, expect, test, vi } from "vitest";
import type { SqlExec } from "../sql-exec.ts";
import { claimSleep, readSleeps, wakeSleeps } from "./workflow-journal-waits.ts";

const SLUG = "tenant-a";

/**
 * A recording `SqlExec` that answers from a queue, one entry per statement;
 * read what it was handed from `mock.calls`.
 */
function recorder(rows: Record<string, unknown>[][] = []) {
  const sql = vi.fn<SqlExec>(async () => []);
  for (const answer of rows) sql.mockResolvedValueOnce(answer);
  return sql;
}

describe("wakeSleeps", () => {
  test("a BARE wake is scoped to `kind = 'sleep'`, never a hook deadline", async () => {
    // Journaling a hook's timeout as an ordinary sleep meant a "send it now" tool
    // also closed every open approval window on the run.
    const sql = recorder([[{ key: "sleep!0" }]]);
    expect(await wakeSleeps(sql, SLUG, "wrun_1", 5, undefined)).toBe(1);
    expect(sql.mock.calls[0]?.[0]).toContain("kind = 'sleep'");
  });

  test("a CORRELATED wake passes its ids and reaches any kind", async () => {
    const sql = recorder([[]]);
    await wakeSleeps(sql, SLUG, "wrun_1", 5, ["order-7"]);
    expect(sql.mock.calls[0]?.[1]).toContainEqual(["order-7"]);
  });
});

describe("claimSleep", () => {
  test("answers the STORED wait, so a replay keeps the first walk's deadline", async () => {
    const sql = recorder([
      [{ wake_at: "1000", woken: true, correlation_id: "order-7", kind: "hook-timeout" }],
    ]);
    await expect(
      claimSleep(sql, SLUG, "wrun_1", "sleep!0", 9999, undefined, "sleep"),
    ).resolves.toEqual({
      wakeAt: 1000,
      woken: true,
      correlationId: "order-7",
      kind: "hook-timeout",
    });
    expect(sql.mock.calls[0]?.[1]).toEqual([SLUG, "wrun_1", "sleep!0", 9999, null, "sleep"]);
  });
});

describe("readSleeps", () => {
  test("maps every row, keyed, with absent correlation ids left absent", async () => {
    const sql = recorder([
      [{ key: "sleep!0", wake_at: "5", woken: false, correlation_id: null, kind: "sleep" }],
    ]);
    await expect(readSleeps(sql, SLUG, "wrun_1")).resolves.toEqual([
      { key: "sleep!0", wakeAt: 5, woken: false, correlationId: undefined, kind: "sleep" },
    ]);
  });
});
