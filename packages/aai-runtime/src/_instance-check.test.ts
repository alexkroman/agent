// Copyright 2026 the AAI authors. MIT license.
/**
 * The instance record the guest reads to tell its one runtime from two.
 */

import { describe, expect, test } from "vitest";
import { recordRuntimeInstance, runtimeInstances } from "./_instance-check.ts";
import { registerMetricsSink } from "./metrics-sink.ts";

describe("the runtime instance record", () => {
  test("a copy records itself on load, and a re-evaluation is not a second copy", () => {
    // `metrics-sink.ts` records at module load — every runtime that runs a session
    // loads it. Re-recording the same URL, which is what `vi.resetModules()` does,
    // leaves the record as it was.
    expect(registerMetricsSink).toBeTypeOf("function");
    const before = runtimeInstances();
    expect(before.length).toBeGreaterThan(0);
    for (const url of before) recordRuntimeInstance(url);
    expect(runtimeInstances()).toEqual(before);
  });
});
