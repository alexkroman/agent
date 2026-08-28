// Copyright 2026 the AAI authors. MIT license.
/**
 * The narrowing the workflow hooks apply to a DEF's input type.
 *
 * It used to fall back to `unknown` so an un-parameterized
 * `useWorkflowSubmit("digest")` kept compiling. It does not any more — the def
 * is required — because the fallback was the last way to get an untyped
 * `submit` back, and an escape hatch nobody needs is one somebody uses.
 *
 * There used to be a `SubmitOutputOf<D>` beside it. It was `WorkflowOutputOf<D>`
 * spelled a second way and nothing else, so the hooks name `WorkflowOutputOf`
 * directly — the SDK type this package already re-exports, and the one a page
 * reading the rendered signature can click through to.
 */

import type { WorkflowInputOf } from "@alexkroman1/aai/workflow-api";

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
