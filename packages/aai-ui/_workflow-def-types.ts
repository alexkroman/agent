// Copyright 2026 the AAI authors. MIT license.
/**
 * The two type extractors the workflow hooks use to read a DEF.
 *
 * They used to fall back to `unknown` so an un-parameterized
 * `useWorkflowSubmit("digest")` kept compiling. It does not any more — the def
 * is required — because the fallback was the last way to get an untyped
 * `submit` back, and an escape hatch nobody needs is one somebody uses.
 *
 * What is left is the narrowing `WorkflowInputOf`/`WorkflowOutputOf` cannot do
 * on their own: a def whose `input` schema is absent has no parsed input, and
 * `never` as a parameter type accepts nothing at all — not even `undefined` —
 * so a workflow that declares no schema would have an uncallable `submit`.
 * It gets `undefined` instead, i.e. `submit(undefined)`. Explicit rather than
 * `void`, which would let the argument be omitted and which Biome's
 * `noConfusingVoidType` rejects outside a return or type-parameter position.
 *
 * An `_`-internal module: plumbing between the hooks and the SDK's workflow
 * types, not API.
 */

import type { WorkflowInputOf, WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";

/**
 * What `submit()` takes for `D` — `undefined` when `D` declares no schema.
 * It is `submit(undefined)` for such a workflow — explicit rather than `void`,
 * which would let the argument be omitted and which Biome rejects here.
 *
 * The `[T] extends [never]` spelling is deliberate: a bare `T extends never`
 * distributes over a naked type parameter and answers `never` for a union.
 */
export type SubmitInputOf<D> = [WorkflowInputOf<D>] extends [never]
  ? undefined
  : WorkflowInputOf<D>;

/** What a completed run of `D` reports. */
export type SubmitOutputOf<D> = WorkflowOutputOf<D>;
