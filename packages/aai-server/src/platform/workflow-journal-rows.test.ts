// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { millis, text, toRun, toStep } from "./workflow-journal-rows.ts";

describe("row codecs", () => {
  test("millis converts a bigint column, which the driver hands over as a string", () => {
    expect(millis("1700000000000")).toBe(1_700_000_000_000);
    expect(millis(7)).toBe(7);
  });

  test("text keeps a stored string and reads anything else as absent", () => {
    expect(text(`{"a":1}`)).toBe(`{"a":1}`);
    expect(text("")).toBe("");
    expect(text(null)).toBeUndefined();
    expect(text(3)).toBeUndefined();
  });

  test("toRun maps the columns, leaving absent diagnostics absent", () => {
    expect(
      toRun({
        run_id: "wrun_1",
        workflow: "digest",
        status: "running",
        created_at: "12",
        input: `{"t":1}`,
        output: null,
        error: null,
        code_version: undefined,
        label: "nightly",
      }),
    ).toEqual({
      runId: "wrun_1",
      workflow: "digest",
      status: "running",
      createdAt: 12,
      input: `{"t":1}`,
      output: undefined,
      error: undefined,
      codeVersion: undefined,
      label: "nightly",
    });
  });

  test("toStep maps the columns and both timestamps", () => {
    expect(
      toStep({
        key: "fetch#0",
        name: "fetch",
        status: "error",
        output: null,
        error: "boom",
        attempts: "2",
        started_at: "3",
        finished_at: "4",
      }),
    ).toEqual({
      key: "fetch#0",
      name: "fetch",
      status: "error",
      output: undefined,
      error: "boom",
      attempts: 2,
      startedAt: 3,
      finishedAt: 4,
    });
  });
});
