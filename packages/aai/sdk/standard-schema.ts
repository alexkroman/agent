// Copyright 2026 the AAI authors. MIT license.
/**
 * The [Standard Schema](https://standardschema.dev) contract, with nothing
 * behind it.
 *
 * Split from `sdk/schema.ts` for one reason: that module imports **zod**, to
 * convert a schema to JSON Schema — and JSON Schema conversion is the half of
 * schema handling this SDK cannot do generically, while VALIDATION is the half
 * every vendor implements itself (`~standard.validate` is a plain method call).
 * So a caller that only validates should not pay for zod's module graph, and
 * one such caller is on `@alexkroman1/aai/utils`: {@link
 * import("./step-generate-json.ts").stepGenerateJson} checks a model's reply
 * against a schema, and `/utils` is the subpath the CLI loads on every
 * invocation (see that module's doc).
 *
 * `sdk/schema.ts` re-exports all of this, so nothing that already imports from
 * there has to move; it is the one place that adds conversion on top.
 */

/**
 * The [Standard Schema](https://standardschema.dev) V1 interface, inlined as
 * the spec recommends (it is a types-only contract). A Zod, ArkType, or
 * Valibot schema all satisfy it.
 *
 * @typeParam Input - The type the schema accepts for validation.
 * @typeParam Output - The type validation produces.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties object. */
  readonly "~standard": {
    /** The version of the standard implemented (always 1). */
    readonly version: 1;
    /** The vendor name, e.g. `"zod"`, `"arktype"`, `"valibot"`. */
    readonly vendor: string;
    /** Validate `value`, returning the typed value or issues. */
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    /** Inferred types, when the vendor exposes them. */
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** A successful or failed Standard Schema validation. */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] };

/** One validation issue in a failed Standard Schema result. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

/** The output (validated) type of a Standard Schema. */
export type InferSchemaOutput<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;

/** Render Standard Schema issues as one human-readable line. */
export function formatSchemaIssues(issues: readonly StandardSchemaIssue[]): string {
  return issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((seg) => String(typeof seg === "object" && seg !== null ? seg.key : seg))
        .join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
