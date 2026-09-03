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
import { type WorkflowInputOf, type WorkflowRunOf, workflow } from "./workflow.ts";
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
  expectTypeOf<WorkflowRunOf<{ nope: true }>>().toEqualTypeOf<WorkflowRunSnapshot<never>>();
});

/**
 * The two schema options, as the types they resolve.
 *
 * Both replace a CAST — `answered.payload as T`, `entry.output as T` — so the
 * question the runtime specs cannot ask is whether the option actually reaches
 * the call site's type. A schema that validated at run time while the body still
 * saw `unknown` would be half the feature and would look like all of it.
 */
declare const ctx: WorkflowCtx;
const Approval = z.object({ approved: z.boolean() });

test("a wait's schema supersedes the type parameter, and a deadline adds `| undefined`", async () => {
  expectTypeOf(await ctx.waitFor("tok", { schema: Approval })).toEqualTypeOf<{
    approved: boolean;
  }>();
  // The deadline arm is the only one that can resolve nothing, which is why the
  // two option bags are separate types.
  expectTypeOf(await ctx.waitFor("tok", { schema: Approval, timeoutMs: 1000 })).toEqualTypeOf<
    { approved: boolean } | undefined
  >();
});

test("a wait with no schema still means what it meant", async () => {
  // The overloads that predate the option, unchanged — every existing body is
  // one of these two calls.
  expectTypeOf(await ctx.waitFor<{ ok: boolean }>("tok")).toEqualTypeOf<{ ok: boolean }>();
  expectTypeOf(await ctx.waitFor<{ ok: boolean }>("tok", { timeoutMs: 5 })).toEqualTypeOf<
    { ok: boolean } | undefined
  >();
});

test("a step's schema decides its result, over whatever the body returned", async () => {
  // `z.coerce` is the case worth pinning: the body produces a string and the
  // step resolves a number, which is only sound because what is JOURNALED is
  // the schema's value rather than the body's.
  const Count = z.object({ n: z.coerce.number() });
  expectTypeOf(await ctx.step("count", () => ({ n: "3" }), { schema: Count })).toEqualTypeOf<{
    n: number;
  }>();
});

test("a step with no schema still infers from the body", async () => {
  expectTypeOf(await ctx.step("count", () => ({ n: 3 }))).toEqualTypeOf<{ n: number }>();
  expectTypeOf(await ctx.step("count", () => "x", { maxAttempts: 2 })).toEqualTypeOf<string>();
});
