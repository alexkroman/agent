// Copyright 2026 the AAI authors. MIT license.
/**
 * Synthetic workflow DEF types for this package's specs.
 *
 * The workflow hooks take a def rather than an output type, and the def is
 * REQUIRED — there is no untyped fallback, because an escape hatch nobody needs
 * is one somebody uses. That leaves the specs, whose subject is upload plumbing
 * and polling rather than typing, needing a def to name.
 *
 * Built structurally rather than with a schema library: `zod` is not a
 * dependency of this package, and `StandardSchemaV1` is published on
 * `@alexkroman1/aai/host-internal`, which a browser package may not import. The
 * shape below is the part of that contract `InferSchemaOutput` reads — the
 * `types.output` slot — and nothing else, which is all a type-level def needs.
 *
 * A `.ts` module rather than a `_test-utils` export because it is types only.
 */

import type { WorkflowDef } from "@alexkroman1/aai";

/** A Standard-Schema-shaped type whose parsed output is `O`. Never constructed. */
type SchemaOf<O extends Record<string, unknown>> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { readonly value: O };
    readonly types?: { readonly input: unknown; readonly output: O } | undefined;
  };
};

/** A workflow taking `I` and answering `O`. */
export type TestWorkflow<
  I extends Record<string, unknown> = Record<string, unknown>,
  O = unknown,
> = WorkflowDef<SchemaOf<I>, O>;

/** The shape most specs here need: one `recording` upload id, an unknown result. */
export type UploadWorkflow = TestWorkflow<{ recording: unknown }>;
