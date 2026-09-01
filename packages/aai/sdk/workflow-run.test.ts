// Copyright 2026 the AAI authors. MIT license.
/**
 * The status union, and the one predicate over it.
 *
 * This file was `workflow-status-align.test.ts`, and every case in it read the
 * Workflow DevKit's own `WorkflowRunStatusSchema`: `WorkflowRunStatus` was a
 * hand-written copy of that union, restated rather than re-exported so
 * `@workflow/world` stayed off the published type surface, and a copy with
 * nothing checking it is how a DevKit release adding a sixth status becomes a
 * snapshot whose `status` no member of the discriminated union accepts.
 *
 * With the DevKit gone the union is OURS, so there is nothing to align against
 * and the alignment cases went. What survives is the half that was never about
 * the DevKit: `isTerminal` and `TERMINAL_WORKFLOW_STATUSES` are two spellings of
 * the same fact, and they can still disagree.
 */

import { describe, expect, test } from "vitest";
import {
  isTerminal,
  TERMINAL_WORKFLOW_STATUSES,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
} from "./workflow-run.ts";

/**
 * Every member the union declares.
 *
 * A `satisfies` record rather than an array, so a status added to
 * `WorkflowRunStatus` and forgotten here is a COMPILE error. An array would just
 * be a shorter list at runtime — the same shape as the drift this guards.
 */
const ALL = {
  pending: true,
  running: true,
  completed: true,
  failed: true,
  cancelled: true,
} as const satisfies Record<WorkflowRunStatus, true>;

const STATUSES = Object.keys(ALL) as WorkflowRunStatus[];

describe("isTerminal", () => {
  test("agrees with TERMINAL_WORKFLOW_STATUSES for every status", () => {
    // The two are one fact written twice — a predicate a page calls, and a list
    // the engine's compare-and-set reads. A status that joined one and not the
    // other is a run that reports finished to a reader and unfinished to a
    // worker, which nothing else would catch.
    for (const status of STATUSES) {
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
      expect(isTerminal(run), status).toBe(
        (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(status),
      );
    }
  });

  test("names exactly the three statuses nothing will change again", () => {
    // Spelled out ONCE, here, because the loop above proves the two agree and
    // not that either is right: both could drift together.
    expect([...TERMINAL_WORKFLOW_STATUSES].sort()).toEqual(["cancelled", "completed", "failed"]);
  });

  test("is false for a run that does not exist yet", () => {
    expect(isTerminal(undefined)).toBe(false);
  });
});
