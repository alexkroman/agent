// Copyright 2026 the AAI authors. MIT license.
/**
 * The map is data, so what is worth asserting is the two properties it was
 * extracted for: it covers the whole status union (a page spreading it cannot
 * end up with a hole), and spreading it to override one member keeps the rest.
 */

import { describe, expect, test } from "vitest";
import { isTerminal, type WorkflowRun } from "./workflow-client.ts";
import { WORKFLOW_STATUS_LABELS } from "./workflow-status-labels.ts";

describe("WORKFLOW_STATUS_LABELS", () => {
  test("names every status", () => {
    // The exhaustiveness argument both template copies were written for, now
    // made once at the SDK boundary: the type is `Record<WorkflowRunStatus, …>`,
    // so a status added upstream is a compile error here rather than a
    // fall-through in each page. This pins the runtime side of that.
    expect(Object.keys(WORKFLOW_STATUS_LABELS).sort()).toEqual([
      "cancelled",
      "completed",
      "failed",
      "pending",
      "running",
    ]);
  });

  test("the three the SDK calls terminal all have a settled-sounding label", () => {
    // Read through `isTerminal` rather than a second list of terminal statuses,
    // which is the drift this map exists to remove rather than reintroduce.
    const terminal = Object.keys(WORKFLOW_STATUS_LABELS).filter((status) =>
      isTerminal({ status } as WorkflowRun),
    );
    expect(terminal.sort()).toEqual(["cancelled", "completed", "failed"]);
  });

  test("every label is non-empty, so no status renders as a blank line", () => {
    for (const label of Object.values(WORKFLOW_STATUS_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test("overriding `running` keeps the other four — the documented call shape", () => {
    const page = { ...WORKFLOW_STATUS_LABELS, running: "Writing…" };
    expect(page.running).toBe("Writing…");
    expect(page.pending).toBe(WORKFLOW_STATUS_LABELS.pending);
    expect(page.cancelled).toBe(WORKFLOW_STATUS_LABELS.cancelled);
  });
});
