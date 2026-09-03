// Copyright 2026 the AAI authors. MIT license.
/**
 * `WorkflowInputOf` and `WorkflowRunOf`, as assignability facts.
 *
 * Both exist to stop a hand-written restatement of a shape the schema already
 * declares, and the failure they prevent is SILENT: `WorkflowBody` takes its
 * input as a parameter, so a wider or subtly different hand-written shape is
 * assignable and compiles. A runtime test cannot see any of that, which is why
 * these are the only assertions there are for it.
 */

import { expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  type WorkflowDef,
  type WorkflowInputOf,
  type WorkflowOutputOf,
  type WorkflowRunOf,
  workflow,
} from "./workflow.ts";
import type { WorkflowCtx } from "./workflow-ctx.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/** A schema with all three shapes a body reads differently: required, optional, defaulted. */
const digest = workflow({
  input: z.object({
    topic: z.string(),
    voice: z.string().optional(),
    limit: z.number().default(5),
  }),
  run: async (input: { topic: string; voice?: string | undefined; limit: number }) => ({
    summary: `${input.topic} (${input.limit})`,
  }),
});

/** A workflow that declares no schema at all — the other arm of every helper. */
const bare = workflow({ run: async () => ({ ok: true }) });

test("WorkflowInputOf is the schema's OUTPUT type, not its input", () => {
  // `.default(5)` makes the property required on the parsed value, which is the
  // half a hand-written parameter gets wrong and then covers with `?? 3`.
  expectTypeOf<WorkflowInputOf<typeof digest>["limit"]>().toEqualTypeOf<number>();
  expectTypeOf<WorkflowInputOf<typeof digest>["topic"]>().toEqualTypeOf<string>();
});

test("an optional property carries `| undefined`, as exactOptionalPropertyTypes needs", () => {
  // What two templates restate by hand with a four-line comment attached.
  expectTypeOf<WorkflowInputOf<typeof digest>>().toExtend<{ voice?: string | undefined }>();
  expectTypeOf<WorkflowInputOf<typeof digest>["voice"]>().toEqualTypeOf<string | undefined>();
});

test("a body annotated with it accepts the parsed input and nothing wider", () => {
  const input: WorkflowInputOf<typeof digest> = { topic: "a", limit: 1 };
  expectTypeOf(input).toExtend<{ topic: string; limit: number }>();
  // The contravariance this exists to close: a WIDER parameter is assignable to
  // `WorkflowBody`, so nothing else reports the mismatch.
  expectTypeOf<{ topic: string; limit: number }>().toExtend<WorkflowInputOf<typeof digest>>();
});

test("WorkflowRunOf is the discriminated snapshot with the output filled in", () => {
  expectTypeOf<WorkflowRunOf<typeof digest>>().toEqualTypeOf<
    WorkflowRunSnapshot<{ summary: string }>
  >();
});

test("WorkflowRunOf still narrows on status", () => {
  // Spelled with `Extract` rather than an `if (run.status === …)` block: the
  // narrowing is the assertion, and a conditional `expectTypeOf` is a lint
  // error here precisely because a runtime one might not run.
  type Run = WorkflowRunOf<typeof digest>;
  expectTypeOf<Extract<Run, { status: "completed" }>["output"]>().toEqualTypeOf<{
    summary: string;
  }>();
  expectTypeOf<Extract<Run, { status: "failed" }>["error"]>().toEqualTypeOf<string>();
  // And the union really has all four arms, so the two above are a narrowing
  // rather than the whole type.
  expectTypeOf<Run["status"]>().toEqualTypeOf<
    "pending" | "running" | "completed" | "failed" | "cancelled"
  >();
});

test("a schemaless workflow still yields a usable pair", () => {
  // No `input` means nothing to parse, and the output widens as any inferred
  // return does — `{ ok: boolean }`, not the literal.
  expectTypeOf<WorkflowRunOf<typeof bare>>().toEqualTypeOf<WorkflowRunSnapshot<{ ok: boolean }>>();
  expectTypeOf<WorkflowInputOf<typeof bare>>().toEqualTypeOf<Record<string, unknown>>();
});

test("neither helper accepts something that is not a workflow definition", () => {
  expectTypeOf<WorkflowInputOf<{ nope: true }>>().toBeNever();
  expectTypeOf<WorkflowOutputOf<{ nope: true }>>().toBeNever();
  expectTypeOf<WorkflowRunOf<{ nope: true }>>().toEqualTypeOf<WorkflowRunSnapshot<never>>();
});

/**
 * ## The declaration shape that used to be `TS7022`
 *
 * `WorkflowOutputOf` derived the output type from the BODY, and `workflow<P,
 * R>()` inferred `R` from `run` — so `typeof theDef` needed the body's
 * signature while the body, annotated from the def, needed `typeof theDef`.
 * The documented way out is to ANNOTATE the declaration, which resolves without
 * the initializer; what an `output` schema adds is that the annotation states
 * the output type ONCE, in the schema, rather than naming it a second time by
 * hand.
 *
 * These four declarations ARE the assertion: they are the shape two template
 * groups hit independently, written out with a body in the position a
 * `workflows/*.ts` module puts it, and this file failing to compile is the
 * regression. The `expectTypeOf`s below say the resolved types are the schema's
 * — a def that resolved to `any` would satisfy no assertion here.
 *
 * `WorkflowOutputOf<typeof annotated>` was `never` before this — the second
 * reading is an assignability test over the whole def, and `run`'s input is a
 * function PARAMETER, so a def carrying an input schema is not assignable to
 * one taking the open `Record<string, unknown>`. The `.toEqualTypeOf` below
 * fails against the old spelling rather than merely being weaker.
 */
const annotatedInput = z.object({ topic: z.string() });
const annotatedOutput = z.object({ headline: z.string(), words: z.number().default(0) });

const annotated: WorkflowDef<typeof annotatedInput, z.infer<typeof annotatedOutput>> = workflow({
  input: annotatedInput,
  output: annotatedOutput,
  run: annotatedFlow,
});

async function annotatedFlow(
  input: WorkflowInputOf<typeof annotated>,
  _ctx: WorkflowCtx,
): Promise<WorkflowOutputOf<typeof annotated>> {
  return { headline: input.topic, words: 1 };
}

test("an output schema types the run without the body's signature", () => {
  expectTypeOf<WorkflowOutputOf<typeof annotated>>().toEqualTypeOf<{
    headline: string;
    words: number;
  }>();
  // And it composes, so a `*_status` tool and a page read the same type.
  expectTypeOf<
    Extract<WorkflowRunOf<typeof annotated>, { status: "completed" }>["output"]
  >().toEqualTypeOf<{ headline: string; words: number }>();
});

test("the schema, not the body, decides the output type", () => {
  // The body returns a WIDER shape than it is declared to. Under body inference
  // that widened what callers were promised, silently; the schema is what
  // `workflow()` now reads, so the extra property is not in the type — which is
  // also the truth about the stored value, since what is journaled is the
  // schema's parsed output.
  const declared = workflow({
    output: z.object({ headline: z.string() }),
    run: () => ({ headline: "a", draft: true }) as { headline: string; draft: boolean },
  });
  expectTypeOf<WorkflowOutputOf<typeof declared>>().toEqualTypeOf<{ headline: string }>();
});

test("a `.default()` in an output schema is REQUIRED on what a caller reads", () => {
  // The mirror of the input rule two lines up: a default makes the property
  // optional to SEND and certain to RECEIVE, and `WorkflowOutputOf` is the
  // receiving end.
  expectTypeOf<WorkflowOutputOf<typeof annotated>["words"]>().toEqualTypeOf<number>();
});

test("a workflow that declares no output still infers from the body", () => {
  // The whole backward-compatibility claim, as a type: `bare` declares nothing
  // and reads exactly as it did.
  expectTypeOf<WorkflowOutputOf<typeof bare>>().toEqualTypeOf<{ ok: boolean }>();
  expectTypeOf<WorkflowOutputOf<typeof digest>>().toEqualTypeOf<{ summary: string }>();
});
