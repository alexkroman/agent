// Copyright 2026 the AAI authors. MIT license.
/**
 * The sweep bodies as TEXT. Moved from `pg-cron.test.ts`, which keeps what is
 * about SCHEDULING them; `pg-cron.scenario.test.ts` runs them against a real
 * Postgres.
 */

import { describe, expect, test } from "vitest";
import {
  assertSqlLiteralSafe,
  SWEEP_CRON_HISTORY,
  SWEEP_RATE_LIMITS,
  SWEEP_SESSION_STATE,
} from "./pg-cron-bodies.ts";
import { SESSION_STATE_RETENTION } from "./platform/session-state.ts";

describe("assertSqlLiteralSafe", () => {
  test("passes a plain constant through", () => {
    expect(assertSqlLiteralSafe("-preview", "SUFFIX")).toBe("-preview");
  });

  test.each(["it's", "100%", "a_b", "a\\b"])("refuses %j, naming the constant", (value) => {
    expect(() => assertSqlLiteralSafe(value, "SUFFIX")).toThrow(/^SUFFIX = /);
  });
});

describe("the session-state sweep", () => {
  test("reaches both tables, because a slot and an event expire together", () => {
    // Slots without their events is a session that reconnects to state it cannot
    // explain; events without slots is a log describing state that is gone.
    expect(SWEEP_SESSION_STATE).toContain("aai_platform.session_slots");
    expect(SWEEP_SESSION_STATE).toContain("aai_platform.session_events");
  });

  test("names no tenant identifier, so there is nothing to quote", () => {
    // The `format(%I)` + `'^app_[a-f0-9]{16}$'` pair existed because one statement
    // addressed every tenant's schema by name. Tenancy is a COLUMN now, so the
    // isolation is structural and the sweep is deliberately tenant-blind — it
    // expires by age across the fleet.
    expect(SWEEP_SESSION_STATE).not.toContain("format(");
    expect(SWEEP_SESSION_STATE).not.toContain("app_");
  });

  test("takes its window from the module that owns the tables", () => {
    // Imported rather than written twice: a retention the sweep and the store
    // disagree about deletes rows one of them believes are live.
    expect(SWEEP_SESSION_STATE).toContain(`interval '${SESSION_STATE_RETENTION}'`);
  });

  test("keeps a row far longer than the in-process grace window", () => {
    // A backstop for a guest that is GONE, not a second opinion about a live one:
    // deleting a row while a caller is still reconnecting is indistinguishable,
    // to them, from the loss durable state exists to remove.
    expect(SESSION_STATE_RETENTION).toBe("2 days");
  });
});

describe("the lease and history sweeps", () => {
  test("lease sweeps delete only expired rows", () => {
    expect(SWEEP_RATE_LIMITS).toContain("reset_at <= now()");
  });

  test("the cron-history sweep prunes pg_cron's own run log", () => {
    // The one table the sweeps themselves grow. Supabase prunes nothing.
    expect(SWEEP_CRON_HISTORY).toContain("delete from cron.job_run_details");
    expect(SWEEP_CRON_HISTORY).toContain("interval '7 days'");
  });
});
