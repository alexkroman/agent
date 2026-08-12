// Copyright 2026 the AAI authors. MIT license.
/**
 * The one thing that keeps `workflow-run.ts`'s restated status union honest.
 *
 * `WorkflowRunStatus` there is a hand-written copy of the Workflow DevKit's own
 * union, restated rather than re-exported so `@workflow/world` stays off the
 * published type surface. A copy with nothing checking it is how a WDK release
 * that adds a sixth status becomes a snapshot whose `status` is a string the
 * discriminated union has no member for — and the failure would land in a page
 * rendering a run, not here.
 *
 * Reading the ENUM rather than asserting a literal list is what makes this a
 * check rather than a second copy.
 */

import { TERMINAL_WORKFLOW_RUN_STATUSES, WorkflowRunStatusSchema } from "@workflow/world";
import { describe, expect, test } from "vitest";
import {
  isTerminal,
  TERMINAL_WORKFLOW_STATUSES,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
} from "./workflow-run.ts";

/**
 * Every member our union declares. Spelled as a `satisfies` record rather than
 * an array so a status added to `WorkflowRunStatus` and forgotten here is a
 * COMPILE error — an array would just be a shorter list at runtime, which is the
 * same shape as the drift this file exists to catch.
 */
const OURS = {
  pending: true,
  running: true,
  completed: true,
  failed: true,
  cancelled: true,
} as const satisfies Record<WorkflowRunStatus, true>;

describe("workflow run status alignment with the Workflow DevKit", () => {
  test("our status union is exactly the WDK's", () => {
    expect(Object.keys(OURS).sort()).toEqual([...WorkflowRunStatusSchema.options].sort());
  });

  test("our terminal set is exactly the WDK's", () => {
    expect([...TERMINAL_WORKFLOW_STATUSES].sort()).toEqual(
      [...TERMINAL_WORKFLOW_RUN_STATUSES].sort(),
    );
  });

  test("every WDK status parses as one of ours", () => {
    for (const status of WorkflowRunStatusSchema.options) {
      expect(WorkflowRunStatusSchema.parse(status)).toBe(status);
      expect(Object.hasOwn(OURS, status)).toBe(true);
    }
  });

  test("isTerminal agrees with the WDK's terminal set for every status", () => {
    for (const status of WorkflowRunStatusSchema.options) {
      // The snapshot union discriminates on `status`, so a terminal member needs
      // its own field to be a legal value; the cast is confined to building the
      // fixture and never widens what `isTerminal` is handed.
      const run = {
        runId: "wrun_1",
        workflow: "digest",
        createdAt: 0,
        status,
        ...(status === "completed" ? { output: null } : {}),
        ...(status === "failed" ? { error: "boom" } : {}),
      } as WorkflowRunSnapshot;
      expect(isTerminal(run)).toBe(
        (TERMINAL_WORKFLOW_RUN_STATUSES as readonly string[]).includes(status),
      );
    }
  });

  test("isTerminal is false for a run that does not exist yet", () => {
    expect(isTerminal(undefined)).toBe(false);
  });
});
