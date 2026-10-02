// Copyright 2026 the AAI authors. MIT license.
/**
 * The abandonment write on its own. `workflow-queue-reconcile.test.ts` covers
 * WHEN the pass reaches for it; this file covers what one call writes and
 * answers.
 */

import { describe, expect, test } from "vitest";
import { captureLogs } from "./_logger-test-utils.ts";
import {
  ABANDONED_RUN_ERROR,
  abandonStalledRun,
  RECONCILE_MAX_ATTEMPTS,
} from "./_reconcile-abandon.ts";
import { createRecordingSql } from "./_sql-test-utils.ts";
import type { SqlExec } from "./sql-exec.ts";

const RUN = { slug: "tenant-a", runId: "wrun_wedged", reconciles: RECONCILE_MAX_ATTEMPTS };

describe("abandonStalledRun", () => {
  const logs = captureLogs();

  test("fails the run with the author-facing reason, compare-and-set on the live statuses", async () => {
    const { sql, calls } = createRecordingSql(() => [{ run_id: RUN.runId }]);
    await expect(abandonStalledRun(sql, RUN)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    const params = calls[0]?.params ?? [];
    expect(params.slice(0, 3)).toEqual([RUN.slug, RUN.runId, "failed"]);
    expect(params).toContain(ABANDONED_RUN_ERROR);
    expect(params).toContainEqual(["pending", "running"]);
    expect(logs.warns()).toHaveLength(1);
  });

  test("a run that settled first is not reported as abandoned, and not warned about", async () => {
    const { sql } = createRecordingSql(() => []);
    await expect(abandonStalledRun(sql, RUN)).resolves.toBe(false);
    expect(logs.warns()).toEqual([]);
  });

  test("a write that throws is swallowed, so the pass can continue", async () => {
    const sql: SqlExec = () => Promise.reject(new Error("connection reset"));
    await expect(abandonStalledRun(sql, RUN)).resolves.toBe(false);
    expect(logs.warns()).toHaveLength(1);
  });

  test("the reason names the budget it gave up at", () => {
    expect(ABANDONED_RUN_ERROR).toContain(`${RECONCILE_MAX_ATTEMPTS} attempts`);
  });
});
