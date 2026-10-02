// Copyright 2026 the AAI authors. MIT license.
// The Postgres attempt lease: what the claim binds, how its count is read,
// and what the release removes. The SQL's own semantics are pinned against a
// real database by the journal's Postgres conformance arm.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { recordingDb } from "../../_db-test-utils.ts";
import { claimAttemptLease, releaseAttemptLease } from "./_attempts.ts";

const LEASE = { runId: "wrun_1", key: "s0#0", holder: "walk_a", leaseMs: 30_000 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("claimAttemptLease", () => {
  test("binds the holder's charge time and the lease floor, and answers the live count", async () => {
    const db = recordingDb([[{ n: "2" }]]);
    await expect(claimAttemptLease(db, "attempts_t", LEASE)).resolves.toBe(2);
    expect(db.issued[0]?.params).toEqual(["wrun_1", "s0#0", "walk_a", "100000", "70000"]);
    expect(db.sql[0]).toContain("insert into attempts_t");
    expect(db.sql[0]).toContain("on conflict (run_id, key) do update");
  });

  test("a statement that returns no row is an error naming the run", async () => {
    await expect(claimAttemptLease(recordingDb([[]]), "attempts_t", LEASE)).rejects.toThrow(
      "workflow attempt claim returned nothing for wrun_1",
    );
  });
});

describe("releaseAttemptLease", () => {
  test("removes only this holder's charge", async () => {
    const db = recordingDb();
    await releaseAttemptLease(db, "attempts_t", { runId: "wrun_1", key: "s0#0", holder: "walk_a" });
    expect(db.sql[0]).toContain("holders - $3::text");
    expect(db.issued[0]?.params).toEqual(["wrun_1", "s0#0", "walk_a"]);
  });
});
