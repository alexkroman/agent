// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createWorkflowContext } from "./testing-workflow-ctx.ts";
import {
  DEFAULT_STEP_MAX_ATTEMPTS,
  type WorkflowDef,
  type WorkflowInputOf,
  type WorkflowOutputOf,
  workflow,
} from "./workflow.ts";
import { DEFAULT_STEP_MAX_ATTEMPTS as FROM_OPTIONS } from "./workflow-ctx-options.ts";

describe("workflow", () => {
  test("is an identity function — the declaration comes back as the same object", () => {
    const def = { description: "d", run: () => ({ ok: true }) };
    expect(workflow(def)).toBe(def);
  });

  test("types the run input from the input schema", () => {
    const digest = workflow({
      input: z.object({ topic: z.string() }),
      run: async (input) => {
        expectTypeOf(input).toEqualTypeOf<{ topic: string }>();
        return input.topic.length;
      },
    });
    expectTypeOf<WorkflowInputOf<typeof digest>>().toEqualTypeOf<{ topic: string }>();
    expectTypeOf(digest).toExtend<WorkflowDef>();
  });

  test("types the result from an output schema when one is declared", () => {
    const scored = workflow({
      output: z.object({ score: z.number() }),
      run: () => ({ score: 1 }),
    });
    expectTypeOf<WorkflowOutputOf<typeof scored>>().toEqualTypeOf<{ score: number }>();
  });

  test("the body it returns runs against a workflow context", async () => {
    const digest = workflow({
      input: z.object({ n: z.number() }),
      run: async (input, ctx) => ctx.step("double", () => input.n * 2),
    });
    await expect(digest.run({ n: 21 }, createWorkflowContext())).resolves.toBe(42);
  });

  test("re-exports the step budget", () => {
    expect(DEFAULT_STEP_MAX_ATTEMPTS).toBe(FROM_OPTIONS);
  });
});
