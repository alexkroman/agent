// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level contracts for `workflow()` — the promises a runtime test cannot
 * make: that the input schema types the `run` parameter, that a step's return
 * type survives the journal round-trip in the author's view of it, that naming a
 * workflow by its DEFINITION types both ends of a run, and that a snapshot's
 * status decides which fields it has.
 *
 * The last two are the whole point of this surface's shape, and neither is
 * observable at runtime: a cast compiles and a wrong `output` type is only wrong
 * in the editor. That is why they are pinned here rather than in
 * `workflow.test.ts`.
 */
import { expectTypeOf, test } from "vitest";
import { z } from "zod";
import { agent, tool } from "./define.ts";
import type { ToolContext } from "./types.ts";
import {
  isTerminal,
  type Journalable,
  type TerminalWorkflowRun,
  type WorkflowClient,
  type WorkflowContext,
  type WorkflowRunSnapshot,
  workflow,
} from "./workflow.ts";

/** A workflow with both halves typed — an input schema and a real return. */
const digest = workflow({
  input: z.object({ topic: z.string(), depth: z.number().optional() }),
  run: (input) => ({ topic: input.topic, words: 12 }),
});

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

test("the run function's return type is inferred onto the definition", () => {
  // What makes `output` typed everywhere downstream. Inferred rather than
  // declared, so an author writes nothing to get it.
  expectTypeOf(digest.run).returns.toEqualTypeOf<
    Promise<{ topic: string; words: number }> | { topic: string; words: number }
  >();
});

test("workflows compose into agent() and are reachable from tool code", () => {
  const def = agent({
    name: "Researcher",
    workflows: { digest },
    tools: {
      research: tool({
        input: z.object({ topic: z.string() }),
        description: "Start research",
        run: (args, ctx) => {
          expectTypeOf(ctx.workflows).toEqualTypeOf<WorkflowClient>();
          // Naming the WORKFLOW rather than a string: this is the call whose
          // input is checked against the workflow's own schema.
          expectTypeOf(ctx.workflows.start(digest, args)).toEqualTypeOf<Promise<string>>();
          return ctx.workflows.start(digest, args);
        },
      }),
    },
  });

  expectTypeOf(def.workflows).toEqualTypeOf<
    Readonly<Record<string, import("./workflow.ts").WorkflowDef>> | undefined
  >();
});

test("start accepts the correlation key, and still accepts a bare name", () => {
  const ctx = {} as ToolContext;
  expectTypeOf(ctx.workflows.start).toBeCallableWith(digest, { topic: "ai" }, { key: "session-7" });
  // The string overload survives for a workflow chosen at runtime — a name read
  // from config or a database is data, not a mistake.
  expectTypeOf(ctx.workflows.start).toBeCallableWith("digest", { topic: "ai" });
});

/**
 * What `get`/`find` resolve to, as types rather than as narrowed values.
 *
 * Written with `Extract` instead of `if (run.status === …)` deliberately: an
 * `expectTypeOf` inside a conditional trips biome's `noConditionalExpect`, and
 * these are claims about the TYPE anyway — there is no value to narrow.
 */
type TypedRun = NonNullable<Awaited<ReturnType<ToolContext["workflows"]["get"]>>>;
type Completed<R> = Extract<WorkflowRunSnapshot<R>, { status: "completed" }>;

test("naming the workflow types a completed run's output", () => {
  const ctx = {} as ToolContext;

  // The payoff: no cast at the read site. `transcription-desk` used to write
  // `run.output as TranscribeOutput` for exactly this.
  type Typed = Awaited<ReturnType<typeof ctx.workflows.get<{ topic: string; words: number }>>>;
  expectTypeOf<Completed<{ topic: string; words: number }>["output"]>().toEqualTypeOf<{
    topic: string;
    words: number;
  }>();
  expectTypeOf<NonNullable<Typed>>().toEqualTypeOf<
    WorkflowRunSnapshot<{ topic: string; words: number }>
  >();

  // Without the workflow there is nothing to infer from, so it stays `unknown`
  // rather than quietly becoming `any`.
  expectTypeOf<Extract<TypedRun, { status: "completed" }>["output"]>().toEqualTypeOf<unknown>();

  expectTypeOf(ctx.workflows.find(digest, "session-7")).toEqualTypeOf<
    Promise<WorkflowRunSnapshot<{ topic: string; words: number }>[]>
  >();
  expectTypeOf(ctx.workflows.cancel("r1")).toEqualTypeOf<Promise<boolean>>();
});

test("the snapshot is discriminated on status", () => {
  type Snap = WorkflowRunSnapshot<{ words: number }>;

  // Each status carries exactly the field it defines, and carries it as
  // NON-optional — which is what removes the `?.` and the cast at every read.
  expectTypeOf<Extract<Snap, { status: "completed" }>["output"]>().toEqualTypeOf<{
    words: number;
  }>();
  expectTypeOf<Extract<Snap, { status: "failed" }>["error"]>().toEqualTypeOf<string>();
  expectTypeOf<Extract<Snap, { status: "sleeping" }>["wakeAt"]>().toEqualTypeOf<number>();

  // And the fields a status does NOT define are absent from it, so a failed run
  // cannot be read for an output.
  expectTypeOf<Extract<Snap, { status: "failed" }>>().not.toHaveProperty("output");
  expectTypeOf<Extract<Snap, { status: "completed" }>>().not.toHaveProperty("error");
  expectTypeOf<Extract<Snap, { status: "pending" | "running" }>>().not.toHaveProperty("wakeAt");
});

test("isTerminal narrows rather than merely answering", () => {
  // Asserted through the guard's own signature rather than by narrowing inside an
  // `if`: a `boolean` return would leave every caller to re-assert the status it
  // had just checked, and `.guards` is what states that it does not.
  expectTypeOf(isTerminal<{ words: number }>).guards.toEqualTypeOf<
    TerminalWorkflowRun<{ words: number }>
  >();
  expectTypeOf<TerminalWorkflowRun<{ words: number }>["status"]>().toEqualTypeOf<
    "completed" | "failed" | "cancelled"
  >();
});

test("Journalable maps data through and non-data to never", () => {
  expectTypeOf<Journalable<string>>().toEqualTypeOf<string>();
  expectTypeOf<Journalable<{ a: number; b: { c: string } }>>().toEqualTypeOf<{
    a: number;
    b: { c: string };
  }>();
  // The point of the type: a value whose identity is its prototype has no
  // journalable form, so the shape it maps to is uninhabited.
  expectTypeOf<Journalable<Date>>().toEqualTypeOf<never>();
  expectTypeOf<Journalable<Map<string, number>>>().toEqualTypeOf<never>();
  expectTypeOf<Journalable<() => void>>().toEqualTypeOf<never>();
  // Nested, so `satisfies Journalable<T>` on a big object names the bad field.
  expectTypeOf<Journalable<{ at: Date }>>().toEqualTypeOf<{ at: never }>();
  // `unknown` is accepted — a value that has not been narrowed is not yet making
  // a claim this could check.
  expectTypeOf<Journalable<unknown>>().toEqualTypeOf<unknown>();
  // And so is `void`, which is what a step body that returns nothing produces. It
  // is not named in the type's first branch (that trips a lint rule) and reaches
  // the same answer by falling through every clause.
  expectTypeOf<Journalable<void>>().toEqualTypeOf<void>();
});
