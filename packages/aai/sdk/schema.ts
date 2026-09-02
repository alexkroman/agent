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
import { isRecord } from "./is-record.ts";
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
function jsonSchemaConverterFor(
  value: unknown,
  io: "input" | "output",
): (() => unknown) | undefined {
  if (!isRecord(value)) return;
  // Kept as `unknown` for the cast below. Narrowing to a record says the value
  // has fields, not that it is a zod schema — the `_zod` marker is what says
  // that — so the cast is against the original value rather than against the
  // narrow, which would be an overlap error and no more true.
  const schema: unknown = value;
  if ("_zod" in value) return () => z.toJSONSchema(schema as z.ZodType, { io });
  if (!("~standard" in value)) return;
  // A vendor converter takes no direction — `toJsonSchema()` IS the vendor's
  // whole contract — so `io` reaches zod only. Both directions of an ArkType
  // schema are therefore the same document.
  const convert = value.toJsonSchema ?? value.toJSONSchema;
  return typeof convert === "function" ? () => convert.call(value) : undefined;
}

/** True when `value` is a schema {@link toToolJsonSchema} can convert. */
export function isConvertibleSchema(value: unknown): value is StandardSchemaV1 {
  // The probe reads only the schema's markers, so the direction cannot change
  // the answer; `"output"` is passed because a value has to be passed.
  return jsonSchemaConverterFor(value, "output") !== undefined;
}

function stripDialect(jsonSchema: unknown): JSONSchema7 {
  const { $schema: _omit, ...rest } = jsonSchema as Record<string, unknown>;
  return rest as JSONSchema7;
}

/** Conversion is pure per schema object AND per direction; cache it (schemas
 *  are module-level constants, but `ctx.generate` converts per call). One map
 *  per direction, because the two conversions of a schema are different
 *  documents — a single map keyed on the schema object would answer the second
 *  caller with the first caller's direction. */
const jsonSchemaCache: Record<"input" | "output", WeakMap<object, JSONSchema7>> = {
  input: new WeakMap(),
  output: new WeakMap(),
};

/**
 * Convert a Standard Schema to the JSON Schema shape providers expect.
 *
 * **`io` selects which SIDE of the schema the document describes, and the two
 * are genuinely different.** Zod's own default is `"output"` — the PARSED
 * value — under which a `.default()` field is always present and therefore
 * `required`, a `.pipe()` reports its post-transform type, and a plain
 * `z.object()` reports `additionalProperties: false` because the parsed value
 * really does carry no extra keys. That is right for a schema describing what a
 * PRODUCER returns (`ctx.generate`'s structured output: the model must emit
 * every field the caller's inferred type promises, and OpenAI's strict
 * structured-output mode additionally requires the closed-world flag). It is
 * wrong for a schema describing what a CALLER sends — an LLM tool's parameters,
 * a workflow's declared input — where a defaulted field is exactly the one the
 * caller may omit. Advertising it as mandatory changes what the model asks the
 * user for and what it emits, which is why the tool-parameter surface passes
 * `"input"`.
 *
 * Under `"input"` a plain `z.object()` carries no `additionalProperties` at
 * all, and that is the honest reading: zod accepts an unknown key and silently
 * DROPS it. An author who wants the closed world says so with `z.strictObject`,
 * which keeps `additionalProperties: false` in both directions — a choice that
 * was invisible under `"output"`, where the two convert identically.
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
export function toToolJsonSchema(
  schema: StandardSchemaV1,
  io: "input" | "output" = "output",
): JSONSchema7 {
  const cache = jsonSchemaCache[io];
  const cached = cache.get(schema);
  if (cached) return cached;
  const convert = jsonSchemaConverterFor(schema, io);
  if (!convert) {
    const vendor = (schema as Partial<StandardSchemaV1>)["~standard"]?.vendor ?? "unknown";
    throw new Error(
      `Cannot convert a "${vendor}" schema to JSON Schema. ` +
        "Use a Zod schema, or a Standard Schema exposing a toJsonSchema() method " +
        "(e.g. ArkType).",
    );
  }
  const result = stripDialect(convert());
  cache.set(schema, result);
  return result;
}
