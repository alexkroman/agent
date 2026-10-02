// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import { createWorkflowContext } from "./testing-workflow-ctx.ts";
import { DEFAULT_STEP_MAX_ATTEMPTS, type WorkflowContext } from "./workflow-ctx.ts";
import { DEFAULT_STEP_MAX_ATTEMPTS as FROM_OPTIONS } from "./workflow-ctx-options.ts";

describe("workflow-ctx", () => {
  test("re-exports the step budget unchanged, so either import path reads one value", () => {
    expect(DEFAULT_STEP_MAX_ATTEMPTS).toBe(FROM_OPTIONS);
  });

  test("a body typed against WorkflowContext runs against the testing context", async () => {
    const body = async (input: { topic: string }, ctx: WorkflowContext) => {
      const brief = await ctx.step("writeBrief", () => `brief: ${input.topic}`);
      return { runId: ctx.runId, brief };
    };
    const ctx = createWorkflowContext();
    const result = await body({ topic: "ai" }, ctx);
    expect(result.brief).toBe("brief: ai");
    expect(result.runId).toBe(ctx.runId);
  });

  test("the context holds no live session handles — a replayed body must not reach one", () => {
    expectTypeOf<WorkflowContext>().not.toHaveProperty("send");
    expectTypeOf<WorkflowContext>().not.toHaveProperty("signal");
    expectTypeOf<WorkflowContext>().toHaveProperty("step");
  });
});
