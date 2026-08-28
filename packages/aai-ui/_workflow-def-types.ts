// Copyright 2026 the AAI authors. MIT license.
/**
 * The two type extractors the workflow hooks use to read a DEF.
 *
 * `WorkflowInputOf` and `WorkflowOutputOf` (on `@alexkroman1/aai/workflow-api`)
 * answer `never` for anything that is not a `WorkflowDef` — which is right for
 * their own job and wrong as a hook's return type, where the un-parameterized
 * call `useWorkflowSubmit("digest")` must keep behaving exactly as it does
 * today. These fall back to `unknown` instead, so naming the def is an
 * OPT-IN that adds typing and omitting it takes nothing away.
 *
 * The `[T] extends [never]` spelling is deliberate: a bare `T extends never`
 * distributes over a naked type parameter and answers `never` for a union,
 * which would silently drop the fallback for exactly the defs that need it
 * least — but silently.
 *
 * An `_`-internal module: this is plumbing between the hooks and the SDK's
 * workflow types, not API.
 */

import type { WorkflowInputOf, WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";

/** What `submit()` takes for `D`, or `unknown` when `D` carries no schema. */
export type SubmitInputOf<D> = [WorkflowInputOf<D>] extends [never] ? unknown : WorkflowInputOf<D>;

/** What a completed run of `D` reports, or `unknown` when `D` is not a def. */
export type SubmitOutputOf<D> = [WorkflowOutputOf<D>] extends [never]
  ? unknown
  : WorkflowOutputOf<D>;
