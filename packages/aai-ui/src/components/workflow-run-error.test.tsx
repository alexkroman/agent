// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { WorkflowRun } from "../workflow-client.ts";
import { WorkflowRunError } from "./workflow-run-error.tsx";

const BASE = { runId: "run_1", workflow: "digest", createdAt: 0 } as const;

describe("WorkflowRunError", () => {
  test("announces a failed run's error", () => {
    // `role="alert"` is the part a reviewer cannot see is missing, and the
    // reason this is a component: the failure lands minutes after the reader
    // looked away, and `<Form>` announces only the submit error.
    const run: WorkflowRun = { ...BASE, status: "failed", error: "page returned no text" };
    render(<WorkflowRunError run={run} />);
    expect(screen.getByRole("alert").textContent).toBe("That run failed: page returned no text");
  });

  test("renders nothing for a run in any other status, or no run at all", () => {
    const runs: (WorkflowRun | undefined)[] = [
      undefined,
      { ...BASE, status: "pending" },
      { ...BASE, status: "running" },
      { ...BASE, status: "completed", output: { headline: "x" } },
      { ...BASE, status: "cancelled" },
    ];
    for (const run of runs) {
      const { container } = render(<WorkflowRunError run={run} />);
      expect(container.innerHTML).toBe("");
    }
  });

  test("className is added rather than replacing the colour", () => {
    render(<WorkflowRunError run={{ ...BASE, status: "failed", error: "x" }} className="mt-2" />);
    expect(screen.getByRole("alert").className).toBe("text-red-600 mt-2");
  });
});
