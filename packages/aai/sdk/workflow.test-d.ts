// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level contracts for `workflow()` — the promises a runtime test cannot
 * make: that the input schema types the `run` parameter, that a step's return
 * type survives the journal round-trip in the author's view of it, and that a
 * workflow composes into `agent()`.
 */
import { expectTypeOf, test } from "vitest";
import { z } from "zod";
import { agent, tool } from "./define.ts";
import type { ToolContext } from "./types.ts";
import { type WorkflowClient, type WorkflowContext, workflow } from "./workflow.ts";

test("the input schema types the run parameter", () => {
  workflow({
    input: z.object({ topic: z.string(), depth: z.number().optional() }),
    async run(input, ctx) {
      expectTypeOf(input).toEqualTypeOf<{ topic: string; depth?: number | undefined }>();
      expectTypeOf(ctx).toEqualTypeOf<WorkflowContext>();
      // A step is transparent to its function's return type — the journal
      // round-trip is real at runtime but must not surface as `unknown` here.
      const n = await ctx.step("count", () => 1);
      expectTypeOf(n).toEqualTypeOf<number>();
      const s = await ctx.step("name", async () => "x");
      expectTypeOf(s).toEqualTypeOf<string>();
      expectTypeOf(ctx.sleep(1)).toEqualTypeOf<Promise<void>>();
      expectTypeOf(ctx.runId).toEqualTypeOf<string>();
    },
  });
});

test("a workflow without a schema still gets a usable input parameter", () => {
  workflow({
    run(input) {
      expectTypeOf(input).toEqualTypeOf<Record<string, unknown>>();
    },
  });
});

test("workflows compose into agent() and are reachable from tool code", () => {
  const digest = workflow({
    input: z.object({ topic: z.string() }),
    run: () => undefined,
  });

  const def = agent({
    name: "Researcher",
    workflows: { digest },
    tools: {
      research: tool({
        inputSchema: z.object({ topic: z.string() }),
        description: "Start research",
        execute: (args, ctx) => {
          expectTypeOf(ctx.workflows).toEqualTypeOf<WorkflowClient>();
          expectTypeOf(ctx.workflows.start("digest", args)).toEqualTypeOf<Promise<string>>();
          return ctx.workflows.start("digest", args);
        },
      }),
    },
  });

  expectTypeOf(def.workflows).toEqualTypeOf<
    Readonly<Record<string, import("./workflow.ts").WorkflowDef>> | undefined
  >();
});

test("ToolContext.workflows is always present", () => {
  expectTypeOf<ToolContext>().toHaveProperty("workflows");
  expectTypeOf<ToolContext["workflows"]>().toEqualTypeOf<WorkflowClient>();
});
