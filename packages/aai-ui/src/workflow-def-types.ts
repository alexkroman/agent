// Copyright 2026 the AAI authors. MIT license.
/**
 * The narrowings the workflow hooks apply to a DEF's input type, and the
 * readings that let a page name a workflow through its AGENT instead.
 *
 * `SubmitInputOf` used to fall back to `unknown` so an un-parameterized
 * `useWorkflowSubmit("digest")` kept compiling. It does not any more — the def
 * is required — because the fallback was the last way to get an untyped
 * `submit` back, and an escape hatch nobody needs is one somebody uses.
 *
 * There used to be a `SubmitOutputOf<D>` beside it. It was `WorkflowOutputOf<D>`
 * spelled a second way and nothing else, so the hooks name `WorkflowOutputOf`
 * directly — the SDK type this package already re-exports, and the one a page
 * reading the rendered signature can click through to.
 *
 * ## Naming a workflow through the agent
 *
 * A page used to need the def itself in scope — `import type { digest } from
 * "./agent.ts"` — which works only when `agent.ts` exports it under a name,
 * and says nothing about the STRING the page then passes: `useWorkflowSubmit<
 * typeof digest>("digets")` typechecks and 404s. {@link WorkflowNameOf} and
 * {@link WorkflowDefOf} read both off the agent's own `workflows` map, so a
 * page writes `import type agentDef from "./agent.ts"` and the name is a
 * literal the compiler knows; a typo is an error naming the keys the agent has.
 * The workflows a build DISCOVERS in `workflows/` are not in that map at the
 * type level — only `agent({ workflows })`'s entries are — so those pages keep
 * the def form.
 */

import type { AnyWorkflowDef, WorkflowInputOf } from "@alexkroman1/aai/workflow-api";

/**
 * What `submit()` takes for `D` — `undefined` when `D` declares no schema.
 *
 * This is what {@link WorkflowInputOf} cannot say on its own: a def whose
 * `input` schema is absent has no parsed input, and `never` as a parameter type
 * accepts nothing at all — not even `undefined` — so a workflow that declares
 * no schema would have an uncallable `submit`. It gets `undefined` instead, i.e.
 * `submit(undefined)`. Explicit rather than `void`, which would let the argument
 * be omitted and which Biome's `noConfusingVoidType` rejects outside a return or
 * type-parameter position.
 *
 * The `[T] extends [never]` spelling is deliberate: a bare `T extends never`
 * distributes over a naked type parameter and answers `never` for a union.
 *
 * @public
 */
export type SubmitInputOf<D> = [WorkflowInputOf<D>] extends [never]
  ? undefined
  : WorkflowInputOf<D>;

/**
 * An agent with a `workflows` map — what `agent({ workflows })` and
 * `workflowApp()` return, and what the agent form of the workflow hooks is
 * parameterized by (`useWorkflowSubmit<typeof agentDef>("digest")`).
 *
 * @public
 */
export type WorkflowAppLike = {
  readonly workflows?: Readonly<Record<string, AnyWorkflowDef>> | undefined;
};

/**
 * The `workflows` map of `App`, or `never` for a type that has none — a
 * workflow DEF, say, which is the other thing a hook's type argument may be.
 * `Extract` rather than `NonNullable`: an absent key infers `unknown`, which
 * `NonNullable` would keep.
 */
type WorkflowsOf<App> = App extends { readonly workflows?: infer W }
  ? Extract<W, Record<string, unknown>>
  : never;

/**
 * The names `App` declares under `workflows` — the literal union a page passes
 * to `useWorkflowSubmit<typeof agentDef>(…)`, `useWorkflowStream`,
 * `useWorkflowRuns` and `<WorkflowFields>`.
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
 * With `Name` left to its default (the whole {@link WorkflowNameOf} union) it
 * is the union of the agent's defs, so an app with ONE workflow — most of them
 * — gets exactly that workflow's types from `<typeof agentDef>` alone, and an
 * app with several names the one it means as a second type argument:
 * `useWorkflowSubmit<typeof agentDef, "digest">("digest")`.
 *
 * @public
 */
export type WorkflowDefOf<App, Name extends string> = WorkflowsOf<App>[Name &
  keyof WorkflowsOf<App>];
