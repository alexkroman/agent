// Copyright 2026 the AAI authors. MIT license.
/**
 * The ways a workflow's DECLARATION is read back as a type.
 *
 * `workflow()` and `WorkflowDef` say what a run IS; these say what it means for
 * the three files that have to agree with it — a `workflows/*.ts` body naming
 * its input, a `client.tsx` naming a completed run's output, and a `*_status`
 * tool naming the snapshot the two compose into. Each reads the declaration
 * rather than restating it, which is the whole point: a restated shape is
 * unchecked (see {@link WorkflowInputOf} on why a body's parameter is
 * contravariant) and drifts from the schema it was copied off.
 *
 * The second half reads the AGENT instead of a def: {@link WorkflowAppLike},
 * {@link WorkflowsOf}, {@link WorkflowNameOf} and {@link WorkflowDefOf} let a
 * page, a hook or a spec name a workflow through `agent({ workflows })` by its
 * declared KEY, with the def's types following. Declared once here and read by
 * `@alexkroman1/aai-ui`'s hooks and `@alexkroman1/aai-runtime/testing`'s
 * `runWorkflow` alike, so the two doors cannot disagree about what "an agent
 * with workflows" is.
 *
 * Split out of `workflow.ts` under the 500-line cap, along the seam a reader
 * already uses — the same split `dialog-types.ts` makes beside `dialog.ts`:
 * what a caller DECLARES lives with the factory, and what reads a declaration
 * back lives here. `workflow.ts` re-exports all three, so no import moved and
 * every published subpath still resolves them where it did.
 */

import type { StandardSchemaV1 } from "./standard-schema.ts";
// Type-only, as below: `workflow.ts` re-exports this module's readings, so the
// cycle is erased rather than real.
import type { AnyWorkflowDef } from "./workflow.ts";
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
 * `run` as `(input: never, ctx: never) => infer R` — `never` is assignable to
 * every parameter type.
 *
 * ## It matches a SHAPE, not a named declaration
 *
 * Both readings test `run`'s signature structurally rather than naming
 * `WorkflowDef`, `WorkflowBody` or `WorkflowContext`. A reading answers the
 * same type either way — `WorkflowDef.run` IS `(input: InferSchemaOutput<P>,
 * ctx: WorkflowContext) => …` — but a reading that names the declaration
 * carries it (and everything `WorkflowContext` reaches) into the contract of
 * every capability that publishes the reading, so a new member on the context
 * a body receives moved a PAGE's type.
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
  readonly run: (input: never, ctx: never) => infer R;
  readonly output?: StandardSchemaV1<unknown, infer O> | undefined;
}
  ? Awaited<unknown extends O ? R : O>
  : never;

/**
 * A workflow's INPUT type — what its declared schema parses to, which is
 * exactly what the body's parameter should be.
 *
 * **The reason it exists is that nothing checks a hand-written parameter.**
 * `WorkflowBody` takes its input as a function PARAMETER, so it is
 * contravariant: a body declaring a WIDER shape than the schema produces is
 * assignable, and a body declaring the same shape with a field's optionality or
 * a default's type subtly different is assignable too. Both compile. A
 * `z.number().default(5)` against a body that writes `input.limit ?? 3` is the
 * sharp version — the schema guarantees `limit` is present, the `??` is dead,
 * and the two numbers disagree with nothing to report it.
 *
 * It reads the parameter `WorkflowDef.run` declares, which IS the schema's
 * output (`InferSchemaOutput<P>`), by matching `run`'s shape — see
 * {@link WorkflowOutputOf} for why a reading matches a shape.
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
 * ## It also reads a SCHEMA, and a bodyless declaration, for the cycle's sake
 *
 * `WorkflowInputOf<typeof def>` inside the body's own module is the obvious
 * spelling and it is `TS7022`: `typeof def` needs the body's signature when the
 * body is what `workflow({ run })` infers from, and the body's parameter names
 * `typeof def`. Two spellings avoid it, and both are read here:
 *
 * - **The input schema itself** — `WorkflowInputOf<typeof digestInput>` for a
 *   named `z.object(…)` const, which is the schema's OUTPUT type exactly as the
 *   def reading answers it. The schema is what the def reads anyway, so the
 *   body names the same declaration one step earlier.
 * - **A two-phase declaration** — `workflow({ input, output }).body(digestFlow)`.
 *   `typeof def` there is fixed by the declaration alone (see
 *   `WorkflowDeclaration`), so a body annotated `WorkflowInputOf<typeof def>`
 *   resolves; and the declaration BEFORE `.body` reads here too, as what its
 *   `body` will accept.
 *
 * Published from `@alexkroman1/aai` as well as `@alexkroman1/aai/workflow-api`.
 * The root is the one an author wants: this annotation lives in a
 * `workflows/*.ts` body, next to the `workflow()` that declared it.
 *
 * @public
 */
export type WorkflowInputOf<D> = D extends {
  readonly run: (input: infer I, ctx: never) => unknown;
}
  ? I
  : D extends StandardSchemaV1<unknown, infer O>
    ? O
    : // `ctx: unknown` here where the `run` reading says `never`: nested one
      // parameter deeper, the direction flips, and the context type must be
      // ACCEPTED by this position rather than assignable to it.
      D extends { readonly body: (run: (input: infer I, ctx: unknown) => unknown) => unknown }
      ? I
      : never;

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

/**
 * An agent with a `workflows` map — what `agent({ workflows })` and
 * `workflowApp()` return, and what the agent form of the workflow hooks and of
 * `runWorkflow` is parameterized by (`useWorkflowSubmit<typeof
 * agentDef>("digest")`, `runWorkflow(agentDef, "digest", input)`).
 *
 * @public
 */
export type WorkflowAppLike = {
  readonly workflows?: Readonly<Record<string, AnyWorkflowDef>> | undefined;
};

/**
 * The `workflows` map of an app def, or `never` when it declares none — the
 * reading {@link WorkflowNameOf} and {@link WorkflowDefOf} are spelled in.
 * `Extract` rather than `NonNullable`: an absent key infers `unknown`, which
 * `NonNullable` would keep.
 *
 * @public
 */
export type WorkflowsOf<App> = App extends { readonly workflows?: infer W }
  ? Extract<W, Record<string, unknown>>
  : never;

/**
 * The names `App` declares under `workflows` — the literal union a page passes
 * to `useWorkflowSubmit<typeof agentDef>(…)`, `useWorkflowStream`,
 * `useWorkflowRuns` and `<WorkflowFields>`, and a spec to `runWorkflow`.
 *
 * `never` for a type with no `workflows` map (a def, an unrelated object), so
 * the agent form of each overloaded hook declines it and the def form is tried.
 * The `[T] extends [never]` guard is load-bearing: `keyof never` is every key.
 *
 * @public
 */
export type WorkflowNameOf<App> = [WorkflowsOf<App>] extends [never]
  ? never
  : keyof WorkflowsOf<App> & string;

/**
 * The def `App` declares under `Name` — what the agent form of a hook derives
 * its input and output from: `WorkflowOutputOf<WorkflowDefOf<App, Name>>`.
 *
 * With `Name` the whole {@link WorkflowNameOf} union it is the union of the
 * agent's defs, so an app with ONE workflow — most of them — gets exactly that
 * workflow's types from `<typeof agentDef>` alone, and an app with several
 * names the one it means as a second type argument:
 * `useWorkflowSubmit<typeof agentDef, "digest">("digest")`.
 *
 * @public
 */
export type WorkflowDefOf<App, Name extends string> = WorkflowsOf<App>[Name &
  keyof WorkflowsOf<App>];
