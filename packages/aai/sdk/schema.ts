// Copyright 2026 the AAI authors. MIT license.
/**
 * Schema acceptance for tool inputs and `ctx.generate` structured output.
 *
 * The SDK accepts any [Standard Schema](https://standardschema.dev) — Zod
 * (the documented default), ArkType, or anything else implementing the
 * `~standard` interface — wherever a schema is taken. Two capabilities are
 * needed from a schema, and they come from different places:
 *
 * - **Validation** is the Standard Schema contract itself
 *   (`~standard.validate`), so every vendor works.
 * - **JSON Schema conversion** (for the LLM tool spec and `generateObject`)
 *   is NOT part of the standard. {@link toToolJsonSchema} converts Zod
 *   natively (`z.toJSONSchema`) and duck-types a `toJsonSchema()` /
 *   `toJSONSchema()` method for vendors that expose one (ArkType does);
 *   anything else is rejected at definition time with a message naming the
 *   options — never silently at the first tool call.
 */

import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

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

/**
 * A schema accepted for tool inputs and `ctx.generate` structured output:
 * any Standard Schema that can also convert to JSON Schema (Zod natively,
 * or a vendor `toJsonSchema()` method). Zod object schemas are the
 * documented default.
 */
export type ToolInputSchema = StandardSchemaV1<unknown, Record<string, unknown>>;

/**
 * The one probe both {@link isConvertibleSchema} and {@link toToolJsonSchema}
 * share: returns the conversion thunk for a schema this SDK can turn into
 * JSON Schema, or `undefined`. A Zod v4 schema instance is recognized by its
 * own `_zod` marker — deliberately NOT the `~standard` interface, which zod
 * also stamps onto its plain `toJSONSchema()` *output* — and other vendors
 * by a `toJsonSchema()` / `toJSONSchema()` method (ArkType).
 */
function jsonSchemaConverterFor(value: unknown): (() => unknown) | undefined {
  if (typeof value !== "object" || value === null) return;
  if ("_zod" in value) return () => z.toJSONSchema(value as z.ZodType);
  if (!("~standard" in value)) return;
  const convert =
    (value as { toJsonSchema?: unknown }).toJsonSchema ??
    (value as { toJSONSchema?: unknown }).toJSONSchema;
  return typeof convert === "function" ? () => convert.call(value) : undefined;
}

/** True when `value` is a schema {@link toToolJsonSchema} can convert. */
export function isConvertibleSchema(value: unknown): value is StandardSchemaV1 {
  return jsonSchemaConverterFor(value) !== undefined;
}

function stripDialect(jsonSchema: unknown): JSONSchema7 {
  const { $schema: _omit, ...rest } = jsonSchema as Record<string, unknown>;
  return rest as JSONSchema7;
}

/** Conversion is pure per schema object; cache it (schemas are module-level
 *  constants, but `ctx.generate` converts per call). */
const jsonSchemaCache = new WeakMap<object, JSONSchema7>();

/**
 * Convert a Standard Schema to the JSON Schema shape providers expect.
 *
 * Strips the `$schema` keyword: `z.toJSONSchema` (Zod v4) tags output with
 * the JSON Schema 2020-12 dialect URI, and some Realtime/S2S providers
 * either reject the field outright or ship it through to the underlying
 * model with a malformed function spec — observed empirically as tool
 * calls that arrive with `args: {}` even when required params are listed.
 *
 * Zod converts natively; other vendors must expose a `toJsonSchema()` (or
 * `toJSONSchema()`) method, as ArkType does. Anything else throws, naming
 * the supported options — at definition/deploy time, not mid-call.
 */
export function toToolJsonSchema(schema: StandardSchemaV1): JSONSchema7 {
  const cached = jsonSchemaCache.get(schema);
  if (cached) return cached;
  const convert = jsonSchemaConverterFor(schema);
  if (!convert) {
    const vendor = (schema as Partial<StandardSchemaV1>)["~standard"]?.vendor ?? "unknown";
    throw new Error(
      `Cannot convert a "${vendor}" schema to JSON Schema. ` +
        "Use a Zod schema, or a Standard Schema exposing a toJsonSchema() method " +
        "(e.g. ArkType).",
    );
  }
  const result = stripDialect(convert());
  jsonSchemaCache.set(schema, result);
  return result;
}

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
