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

import { isRecord } from "./is-record.ts";

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
  /**
   * A union's per-branch issues, one entry per branch — an off-spec VENDOR
   * EXTENSION, which is why it is typed `unknown` rather than described.
   *
   * Standard Schema declares a flat `{ message, path }`, so a validator with
   * alternatives has nowhere to put the reason each one was rejected. Zod
   * therefore passes an `errors` array through the `~standard` interface
   * anyway, and its parent issue's own `message` is the placeholder
   * `"Invalid input"`. {@link formatSchemaIssues} reads this when it is
   * shaped like branches and ignores it otherwise; nothing in this SDK
   * requires a vendor to supply it, and no caller should produce it.
   */
  readonly errors?: unknown;
}

/** The output (validated) type of a Standard Schema. */
export type InferSchemaOutput<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;

/**
 * How far {@link formatSchemaIssues} follows nested union branches.
 *
 * A bound rather than a trust: the nesting comes from a vendor, so a schema of
 * unions-of-unions could otherwise cost a line per combination — and this runs
 * on the failure path of every validating surface here, the platform's error
 * handler included. Four levels is deeper than any schema in this repo.
 */
const MAX_ISSUE_DEPTH = 4;

/** Render Standard Schema issues as one human-readable line. */
export function formatSchemaIssues(issues: readonly StandardSchemaIssue[]): string {
  return renderIssues(issues, [], 0);
}

type PathSegments = readonly (PropertyKey | { readonly key: PropertyKey })[];

function renderIssues(
  issues: readonly StandardSchemaIssue[],
  parentPath: PathSegments,
  depth: number,
): string {
  return issues.map((issue) => renderIssue(issue, parentPath, depth)).join("; ");
}

function renderIssue(issue: StandardSchemaIssue, parentPath: PathSegments, depth: number): string {
  // A nested issue's path is RELATIVE to the union that holds it, so a branch
  // renders `llm.model` only if the parent's own path is carried down.
  const path: PathSegments = [...parentPath, ...(issue.path ?? [])];
  if (depth < MAX_ISSUE_DEPTH) {
    const branches = unionBranches(issue);
    if (branches) {
      // Branches commonly fail identically (two object arms both missing the
      // same key), and one reason stated twice reads as two problems.
      const rendered = new Set(branches.map((branch) => renderIssues(branch, path, depth + 1)));
      return [...rendered].join(" or ");
    }
  }
  const label = path
    .map((seg) => String(typeof seg === "object" && seg !== null ? seg.key : seg))
    .join(".");
  return label ? `${label}: ${issue.message}` : issue.message;
}

/**
 * The usable per-branch issues of a union issue, or `undefined` — in which case
 * the caller renders the parent's own message, which is what it always did.
 *
 * Every read here is structural because {@link StandardSchemaIssue.errors} is a
 * vendor extension with no contract: a shape we did not expect must degrade to
 * the old output rather than throw out of a formatter that error paths call.
 */
function unionBranches(issue: StandardSchemaIssue): readonly StandardSchemaIssue[][] | undefined {
  if (!Array.isArray(issue.errors)) return undefined;
  // Immediately widen away the `any[]` that `Array.isArray` narrows to, so no
  // `any` reaches the loop below.
  const rawBranches: readonly unknown[] = issue.errors;
  const branches: StandardSchemaIssue[][] = [];
  for (const rawBranch of rawBranches) {
    if (!Array.isArray(rawBranch)) continue;
    const raw: readonly unknown[] = rawBranch;
    const branch = raw.filter(isIssue);
    if (branch.length > 0) branches.push(branch);
  }
  return branches.length > 0 ? branches : undefined;
}

/** Whether a vendor-supplied value carries the one field a render needs. */
function isIssue(value: unknown): value is StandardSchemaIssue {
  return isRecord(value) && typeof value.message === "string";
}
