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
 *   (`~standard.validate`), so every vendor works. That half needs nothing
 *   from this module and lives in `sdk/standard-schema.ts`, which is
 *   dependency-free and re-exported below — see its doc for why the split
 *   exists (`/utils` validates, and may not pull zod).
 * - **JSON Schema conversion** (for the LLM tool spec and structured output)
 *   is NOT part of the standard. {@link toToolJsonSchema} converts Zod
 *   natively (`z.toJSONSchema`) and duck-types a `toJsonSchema()` /
 *   `toJSONSchema()` method for vendors that expose one (ArkType does);
 *   anything else is rejected at definition time with a message naming the
 *   options — never silently at the first tool call.
 */

import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import type { StandardSchemaV1 } from "./standard-schema.ts";

export {
  formatSchemaIssues,
  type InferSchemaOutput,
  type StandardSchemaIssue,
  type StandardSchemaResult,
  type StandardSchemaV1,
} from "./standard-schema.ts";

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
