// Copyright 2026 the AAI authors. MIT license.
// The workflow-key case list against the memory reference on its own, and its
// id fixture. `keys-conformance.test.ts` runs the same list through
// `workflowKeyConformance` for every unit-tier arm.

import { describe, expect, test } from "vitest";
import { createMemoryKeyStore } from "./keys.ts";
import { workflowKeyConformanceCases, workflowKeyIds } from "./keys-conformance-cases.ts";

const store = createMemoryKeyStore();

workflowKeyConformanceCases({
  label: "memory (case list)",
  keys: () => store,
  uid: workflowKeyIds("mem-cases"),
});

describe("workflowKeyIds", () => {
  test("mints distinct ids that sort in minting order", () => {
    const uid = workflowKeyIds("lbl");
    const ids = [uid(), uid(), uid()];
    expect(new Set(ids).size).toBe(3);
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]?.startsWith(`wkey-lbl-${process.pid}-`)).toBe(true);
  });
});
