// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { type AnyWorkflowDef, workflow } from "./workflow.ts";
import { declaredWorkflowName, recordWorkflowNames, workflowNameOf } from "./workflow-names.ts";

function def(): AnyWorkflowDef {
  return workflow({
    description: "a def",
    input: z.object({}),
    run: async () => ({ ok: true }),
  });
}

describe("workflowNameOf", () => {
  test("answers undefined for a def no lowering has recorded", () => {
    expect(workflowNameOf(def())).toBeUndefined();
  });

  test("records the key of the lowering, first key winning within one map", () => {
    const shared = def();
    recordWorkflowNames({ first: shared, second: shared });
    expect(workflowNameOf(shared)).toBe("first");
  });

  test("a later lowering renames a def it holds under another key", () => {
    const d = def();
    recordWorkflowNames({ old: d });
    recordWorkflowNames({ renamed: d });
    expect(workflowNameOf(d)).toBe("renamed");
  });
});

describe("declaredWorkflowName", () => {
  test("trusts the recorded name only when the map agrees with it", () => {
    const d = def();
    recordWorkflowNames({ recorded: d });
    expect(declaredWorkflowName({ recorded: d }, d)).toBe("recorded");
    // The same def under another key in THIS map: the map wins over the record.
    expect(declaredWorkflowName({ local: d }, d)).toBe("local");
  });

  test("scans an unlowered map, first key winning, and answers undefined for a stranger", () => {
    const a = def();
    const b = def();
    expect(declaredWorkflowName({ a, b }, b)).toBe("b");
    expect(declaredWorkflowName({ twice: a, again: a }, a)).toBe("twice");
    expect(declaredWorkflowName({ a }, b)).toBeUndefined();
  });
});
