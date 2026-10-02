// Copyright 2026 the AAI authors. MIT license.
// The Postgres journal's row codecs: driver shapes in, the absences the memory
// and platform journals answer out.

import { describe, expect, test } from "vitest";
import { encodeStorageJson } from "../typed-json.ts";
import {
  encodedOrNull,
  millis,
  type RunRow,
  toRunRecord,
  toSleepRecord,
  toStepEntry,
} from "./_postgres-rows.ts";

const RUN: RunRow = {
  run_id: "wrun_1",
  workflow: "digest",
  status: "running",
  created_at: "1700000000000",
  input: null,
  output: null,
  error: null,
  code_version: null,
  label: null,
};

describe("toRunRecord", () => {
  test("a bare row reads with no optional fields, and input UNDEFINED rather than null", () => {
    expect(toRunRecord(RUN)).toEqual({
      runId: "wrun_1",
      workflow: "digest",
      status: "running",
      createdAt: 1_700_000_000_000,
      input: undefined,
    });
    expect(toRunRecord(RUN)).not.toHaveProperty("output");
  });

  test("every set column decodes, typed JSON included", () => {
    const record = toRunRecord({
      ...RUN,
      status: "failed",
      input: encodeStorageJson({ topic: "x", at: new Date(0) }),
      output: encodeStorageJson([1, 2]),
      error: "boom",
      code_version: "v3",
      label: "call the plumber",
    });
    expect(record).toMatchObject({
      input: { topic: "x", at: new Date(0) },
      output: [1, 2],
      error: { message: "boom" },
      codeVersion: "v3",
      label: "call the plumber",
    });
  });
});

describe("toStepEntry", () => {
  test("reads the bigint timestamps as numbers and omits absent output/error", () => {
    const entry = toStepEntry({
      key: "s0#0",
      name: "fetch",
      status: "ok",
      output: encodeStorageJson("done"),
      error: null,
      attempts: 2,
      started_at: "10",
      finished_at: 20,
    });
    expect(entry).toEqual({
      key: "s0#0",
      name: "fetch",
      status: "ok",
      output: "done",
      attempts: 2,
      startedAt: 10,
      finishedAt: 20,
    });
  });
});

describe("toSleepRecord", () => {
  test("a NULL correlation id reads as undefined", () => {
    expect(
      toSleepRecord({ wake_at: "50", woken: false, correlation_id: null, kind: "sleep" }),
    ).toEqual({
      wakeAt: 50,
      woken: false,
      correlationId: undefined,
      kind: "sleep",
    });
  });
});

describe("the scalar helpers", () => {
  test("millis reads a driver string; encodedOrNull never binds undefined", () => {
    expect(millis("42")).toBe(42);
    expect(encodedOrNull(undefined)).toBeNull();
    expect(encodedOrNull({ a: 1 })).toBe(encodeStorageJson({ a: 1 }));
    // A JSON null is a VALUE and is encoded, unlike an absent one.
    expect(encodedOrNull(null)).toBe(encodeStorageJson(null));
  });
});
