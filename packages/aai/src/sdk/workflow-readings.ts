// Copyright 2026 the AAI authors. MIT license.
/**
 * The three ways a workflow's DECLARATION is read back as a type.
 *
 * `workflow()` and `WorkflowDef` say what a run IS; these say what it means for
 * the three files that have to agree with it — a `workflows/*.ts` body naming
 * its input, a `client.tsx` naming a completed run's output, and a `*_status`
 * tool naming the snapshot the two compose into. Each reads the declaration
 * rather than restating it, which is the whole point: a restated shape is
 * unchecked (see {@link WorkflowInputOf} on why a body's parameter is
 * contravariant) and drifts from the schema it was copied off.
 *
 * Split out of `workflow.ts` under the 500-line cap, along the seam a reader
 * already uses — the same split `dialog-types.ts` makes beside `dialog.ts`:
 * what a caller DECLARES lives with the factory, and what reads a declaration
 * back lives here. `workflow.ts` re-exports all three, so no import moved and
 * every published subpath still resolves them where it did.
 */

import type { InferSchemaOutput } from "./schema.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";
import type { WorkflowBody, WorkflowDef } from "./workflow.ts";
// Type-only, so the cycle with `workflow-run.ts` (which names `WorkflowClient`
// in its own docs) is erased rather than real. `WorkflowRunOf` composes the
// snapshot with a def's output type, which is what moved this import here with
// it.
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/**
 * A workflow's OUTPUT type, for a page that polls its runs.
 *
 * This is the end-to-end typing a static page would otherwise be missing.
 * `useWorkflowRun<R>` makes `run.status === "completed"` narrow to a typed
 * `run.output`, and without this the page has to name `R` by hand — restating a
 * shape the agent module already declares, with nothing checking the two agree.
 *
 * It needs no build step and no generated `.d.ts`, because the reason a page
 * "cannot import the agent" does not survive contact with `import type`: a
 * type-only import is ERASED, so it drags no server graph into the browser
 * bundle.
 *
 * @example
 * ```ts no-check
 * // agent.ts
 * export const transcribe = workflow({ input: …, output: transcriptSchema, run: transcribeFlow });
 *
 * // client.tsx — `import type` is erased, so nothing server-side is bundled.
 * import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
 * import type { transcribe } from "./agent.ts";
 *
 * const run = useWorkflowRun<WorkflowOutputOf<typeof transcribe>>(runId, { api });
 * if (run?.status === "completed") console.log(run.output.text); // typed
 * ```
 *
 * ## It reads the declared SCHEMA first, and that is what breaks a cycle
 *
 * The DECLARATION is the better source of this type, and the worse one used to
 * be the only one. Deriving `R` from the body means `typeof theDef` needs the
 * body's signature — while a body annotated `WorkflowInputOf<typeof theDef>`
 * needs `typeof theDef`, which is `TS7022` reported against `agent.ts`. The
 * documented way out is to ANNOTATE the declaration, and an annotation whose
 * `R` comes from a schema (`WorkflowDef<typeof digestInput, z.infer<typeof
 * digestOutput>>`) states the output type once, in the schema, rather than
 * naming it a second time by hand.
 *
 * That annotated shape is also what the second reading gets WRONG, which is
 * the other half of this rewrite. `D extends WorkflowDef<ToolInputSchema, infer
 * R>` is an assignability test over the whole def, and `run`'s input is a
 * function PARAMETER — so a def carrying an input schema is not assignable to
 * one taking the open `Record<string, unknown>`, and the conditional silently
 * fell to `never`. It is the same contravariance `AnyWorkflowDef` was
 * written for, reached by the other route, and it is why the test below matches
 * `run` as `WorkflowBody<never, infer R>` — `never` is assignable to every
 * parameter type.
 *
 * `unknown extends O` is how "declared nothing" is told from "declared a
 * schema": a def with no output schema still HAS the optional property in its
 * type, carrying `R` — so the two readings agree, and the fallback only ever
 * fires for a def-shaped object that names no output at all.
 *
 * `Awaited` because a body may be sync or async and the snapshot always holds
 * the settled value.
 *
 * On `@alexkroman1/aai/workflow-api` only, unlike its two siblings: its reader
 * is a page. Both templates that name it are a `client.tsx` parameterizing
 * `useWorkflowRun<…>`, and a `*_status` tool wants `WorkflowRunOf`, which
 * composes this in already.
 *
 * @public
 */
export type WorkflowOutputOf<D> = D extends {
  run: WorkflowBody<never, infer R>;
  output?: StandardSchemaV1<unknown, infer O> | undefined;
}
  ? Awaited<unknown extends O ? R : O>
  : never;

/**
 * A workflow's INPUT type — what its declared schema parses to, which is
 * exactly what the body's parameter should be.
 *
 * **The reason it exists is that nothing checks a hand-written parameter.**
 * {@link WorkflowBody} takes its input as a function PARAMETER, so it is
 * contravariant: a body declaring a WIDER shape than the schema produces is
 * assignable, and a body declaring the same shape with a field's optionality or
 * a default's type subtly different is assignable too. Both compile. A
 * `z.number().default(5)` against a body that writes `input.limit ?? 3` is the
 * sharp version — the schema guarantees `limit` is present, the `??` is dead,
 * and the two numbers disagree with nothing to report it.
 *
 * Two details a restated shape gets wrong by hand, both of which this gets
 * right for free. A zod `.optional()` infers a property that may be PRESENT AND
 * `undefined`, which under `exactOptionalPropertyTypes` is `?: T | undefined`
 * and not `?: T` — two templates carry the same four-line comment explaining
 * that, which is a comment `z.infer` makes unnecessary. And a `.default()` makes
 * the OUTPUT property required while the input stays optional, so a body reading
 * it needs no fallback at all.
 *
 * Like {@link WorkflowOutputOf}, it needs no build step: `import type` is
 * erased, so a body in `workflows/` naming `WorkflowInputOf<typeof theDef>`
 * through a type-only import of `../agent.ts` drags no runtime cycle behind it.
 *
 * @example
 * ```ts no-check
 * // agent.ts
 * export const digest = workflow({
 *   input: z.object({ topic: z.string(), limit: z.number().default(5) }),
 *   run: digestFlow,
 * });
 *
 * // workflows/digest.ts — `import type` is erased, so there is no cycle.
 * import type { WorkflowInputOf } from "@alexkroman1/aai";
 * import type { digest } from "../agent.ts";
 *
 * export async function digestFlow(input: WorkflowInputOf<typeof digest>, ctx: WorkflowContext) {
 *   // `limit` is `number`, not `number | undefined` — the default already ran.
 *   return await research(input.topic, input.limit);
 * }
 * ```
 *
 * Published from `@alexkroman1/aai` as well as `@alexkroman1/aai/workflow-api`.
 * The root is the one an author wants: this annotation lives in a
 * `workflows/*.ts` body, next to the `workflow()` that declared it.
 *
 * @public
 */
export type WorkflowInputOf<D> =
  D extends WorkflowDef<infer P, unknown> ? InferSchemaOutput<P> : never;

/**
 * A run of `D`, with its output already typed — `WorkflowRunSnapshot` and
 * {@link WorkflowOutputOf} composed.
 *
 * The composition is what a tool reporting on a run actually holds, and writing
 * it out costs a three-name import (`WorkflowRunSnapshot`, `WorkflowOutputOf`,
 * and the def) at every such tool. Two templates compose it by hand today, in
 * files whose whole job is to answer "how is that run going".
 *
 * The result is still the DISCRIMINATED union, so `isTerminal(run)` and
 * `run.status === "completed"` narrow exactly as they do on the uncomposed type
 * — this names the shape, it does not flatten it.
 *
 * @example
 * ```ts no-check
 * import type { WorkflowRunOf } from "@alexkroman1/aai";
 * import { isTerminal } from "@alexkroman1/aai/workflow-api";
 * import type { research } from "../agent.ts";
 *
 * function describe(run: WorkflowRunOf<typeof research>): string {
 *   if (!isTerminal(run)) return "still working on it";
 *   return run.status === "completed" ? run.output.summary : "that one did not finish";
 * }
 * ```
 *
 * Published from `@alexkroman1/aai` as well as `@alexkroman1/aai/workflow-api`,
 * because the caller this composition was written for is a `*_status` TOOL.
 * Note `isTerminal` is on `/workflow-api` only — it is a value, so it is not
 * erased, and a tool importing it is importing the client half on purpose.
 *
 * @public
 */
export type WorkflowRunOf<D> = WorkflowRunSnapshot<WorkflowOutputOf<D>>;
