// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { toWdkRunRecord } from "./wdk-record.ts";

const base = { runId: "r1", workflowName: "call", createdAt: 5 };

describe("toWdkRunRecord", () => {
  test("carries output only when completed, error only when failed, label when set", () => {
    expect(toWdkRunRecord({ ...base, status: "completed", output: 1, label: "Call Sam" })).toEqual({
      ...base,
      status: "completed",
      output: 1,
      label: "Call Sam",
    });
    expect(
      toWdkRunRecord({ ...base, status: "running", output: 1, error: { message: "x" } }),
    ).toEqual({
      ...base,
      status: "running",
    });
    expect(toWdkRunRecord({ ...base, status: "failed", error: { message: "x" } })).toEqual({
      ...base,
      status: "failed",
      error: { message: "x" },
    });
  });

  test("a completed run whose output is undefined still carries the key", () => {
    expect(toWdkRunRecord({ ...base, status: "completed" })).toHaveProperty("output", undefined);
  });
});
