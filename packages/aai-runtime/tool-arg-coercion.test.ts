// Copyright 2026 the AAI authors. MIT license.

import type { JSONSchema7 } from "json-schema";
import { describe, expect, test } from "vitest";
import { coerceToolArgs } from "./tool-arg-coercion.ts";

const schema = (properties: Record<string, unknown>): JSONSchema7 =>
  ({ type: "object", properties }) as JSONSchema7;

describe("coerceToolArgs", () => {
  test("coerces a numeric string when the property is a number", () => {
    const out = coerceToolArgs({ max_price: "1500" }, schema({ max_price: { type: "number" } }));
    expect(out).toEqual({ max_price: 1500 });
  });

  test("coerces a boolean string when the property is a boolean", () => {
    const out = coerceToolArgs(
      { pets_allowed: "true", furnished: "FALSE" },
      schema({ pets_allowed: { type: "boolean" }, furnished: { type: "boolean" } }),
    );
    expect(out).toEqual({ pets_allowed: true, furnished: false });
  });

  test("coerces within union types (string|number|boolean value field)", () => {
    const props = schema({ value: { type: ["string", "number", "boolean"] } });
    expect(coerceToolArgs({ value: "1500" }, props)).toEqual({ value: 1500 });
    expect(coerceToolArgs({ value: "true" }, props)).toEqual({ value: true });
    expect(coerceToolArgs({ value: "Northside" }, props)).toEqual({ value: "Northside" });
  });

  test("coerces via anyOf branches", () => {
    const props = schema({ value: { anyOf: [{ type: "boolean" }, { type: "string" }] } });
    expect(coerceToolArgs({ value: "false" }, props)).toEqual({ value: false });
  });

  test("never rewrites a string-only property (free text stays verbatim)", () => {
    const props = schema({ query: { type: "string" } });
    expect(coerceToolArgs({ query: "1984" }, props)).toEqual({ query: "1984" });
    expect(coerceToolArgs({ query: "true" }, props)).toEqual({ query: "true" });
  });

  test("coerces unambiguous literals when the property has no type info", () => {
    const props = schema({ value: {} });
    expect(coerceToolArgs({ value: "42" }, props)).toEqual({ value: 42 });
    expect(coerceToolArgs({ value: "true" }, props)).toEqual({ value: true });
    expect(coerceToolArgs({ value: "42nd street" }, props)).toEqual({ value: "42nd street" });
  });

  test("integer-only properties reject decimal strings", () => {
    const props = schema({ quantity: { type: "integer" } });
    expect(coerceToolArgs({ quantity: "2" }, props)).toEqual({ quantity: 2 });
    expect(coerceToolArgs({ quantity: "2.5" }, props)).toEqual({ quantity: "2.5" });
  });

  test("negative and decimal numbers coerce for number properties", () => {
    const props = schema({ delta: { type: "number" } });
    expect(coerceToolArgs({ delta: "-3.25" }, props)).toEqual({ delta: -3.25 });
  });

  test("non-string values pass through; keys missing from the schema coerce like untyped ones", () => {
    const props = schema({ max_price: { type: "number" } });
    const args = { max_price: 1500, extra: "true" };
    expect(coerceToolArgs(args, props)).toEqual({ max_price: 1500, extra: true });
  });

  test("does not mutate the input object", () => {
    const props = schema({ max_price: { type: "number" } });
    const args = { max_price: "1500" };
    const out = coerceToolArgs(args, props);
    expect(args.max_price).toBe("1500");
    expect(out).not.toBe(args);
  });

  test("returns the same object when nothing needs coercion", () => {
    const props = schema({ city: { type: "string" } });
    const args = { city: "Dallas" };
    expect(coerceToolArgs(args, props)).toBe(args);
  });

  test("handles a schema without properties", () => {
    const args = { anything: "true" };
    expect(coerceToolArgs(args, { type: "object" } as JSONSchema7)).toBe(args);
  });

  test("infers allowed types from enum values", () => {
    const props = schema({ mode: { enum: ["driving", "transit"] } });
    // enum of strings → string-only → no coercion even of numerics
    expect(coerceToolArgs({ mode: "12" }, props)).toEqual({ mode: "12" });
    const numeric = schema({ level: { enum: [1, 2, 3] } });
    expect(coerceToolArgs({ level: "2" }, numeric)).toEqual({ level: 2 });
  });
});
