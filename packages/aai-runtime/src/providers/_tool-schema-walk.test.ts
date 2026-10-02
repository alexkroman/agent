// Copyright 2026 the AAI authors. MIT license.
/**
 * The schema-position walk every tool-schema rule set runs through: where it
 * descends (arrays, `$defs`, `items`, `anyOf`, `properties`), where it must NOT
 * (a keyword whose value is data), and that a node nothing rewrites comes back
 * by identity. Driven with the real rule sets, as production drives it; the
 * rules themselves are `_tool-schema-compat.test.ts`'s subject.
 */

import type { JSONSchema7 } from "json-schema";
import { describe, expect, test } from "vitest";
import { GATEWAY_SCHEMA_RULES, GEMINI_SCHEMA_RULES } from "./_tool-schema-compat.ts";
import { rewriteToolSchema } from "./_tool-schema-walk.ts";

/** The unconditional layer, as every non-Gemini model on the gateway gets it. */
function forEveryModel(schema: JSONSchema7): JSONSchema7 {
  return rewriteToolSchema(schema, GATEWAY_SCHEMA_RULES);
}

/** The Gemini layer: the two unconditional removals plus the lossy rewrites. */
function forGemini(schema: JSONSchema7): JSONSchema7 {
  return rewriteToolSchema(schema, GEMINI_SCHEMA_RULES);
}

/** One property's rewritten schema — what most of the cases below are about. */
function propertyOf(schema: JSONSchema7, name: string): unknown {
  const properties = schema.properties;
  return properties?.[name];
}

/** A one-property object schema, the shape a tool's parameters always take. */
function objectWith(name: string, property: JSONSchema7): JSONSchema7 {
  return { type: "object", properties: { [name]: property } };
}

describe("the walk, under the unconditional layer", () => {
  test("prunes inside an array-valued keyword", () => {
    // `anyOf`/`oneOf` branches are an array of schemas, so the walk has to
    // descend through arrays as well as objects.
    const out = forEveryModel(
      objectWith("mode", {
        anyOf: [{ type: "string" }, { type: "object", propertyNames: { type: "string" } }],
      }),
    );
    expect(propertyOf(out, "mode")).toEqual({ anyOf: [{ type: "string" }, { type: "object" }] });
  });

  test("prunes inside $defs, which a recursive schema puts its body in", () => {
    const out = forEveryModel({
      type: "object",
      properties: { node: { $ref: "#/$defs/node" } },
      $defs: { node: { type: "object", propertyNames: { type: "string" } } },
    });
    expect(out.$defs?.node).toEqual({ type: "object" });
    // The `$ref` itself is a known gap: our conversion inlines reused schemas,
    // so one only arises from recursion, where every rewrite available is lossy.
    expect(propertyOf(out, "node")).toEqual({ $ref: "#/$defs/node" });
  });

  test("returns a clean schema by IDENTITY", () => {
    // The rewrite runs on every request of every model, so the common case — a
    // schema with nothing to remove — must allocate nothing.
    const clean: JSONSchema7 = { type: "object", properties: { path: { type: "string" } } };
    expect(forEveryModel(clean)).toBe(clean);
  });

  test("does not walk into a keyword whose value is DATA rather than a schema", () => {
    // The walk this replaced recursed into every nested object, so an author's
    // `default` that happened to be shaped like a schema had keywords deleted
    // out of it. A default is the value a tool receives, not a schema.
    const out = forEveryModel(
      objectWith("config", { type: "object", default: { $schema: "keep me", propertyNames: 1 } }),
    );
    expect(propertyOf(out, "config")).toEqual({
      type: "object",
      default: { $schema: "keep me", propertyNames: 1 },
    });
  });
});

describe("the Gemini layer: where the rules reach", () => {
  test("rewrites a schema nested under items, anyOf and properties alike", () => {
    const out = forGemini({
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "string", minLength: 1 } },
        mode: {
          anyOf: [
            { type: "string", maxLength: 4 },
            { type: "number", minimum: 2 },
          ],
        },
      },
    });
    expect(out.properties).toEqual({
      rows: {
        type: "array",
        items: { type: "string", description: "constraints: minimum length 1" },
      },
      mode: {
        anyOf: [
          { type: "string", description: "constraints: maximum length 4" },
          { type: "number", description: "constraints: greater than or equal to 2" },
        ],
      },
    });
  });

  test("does not write a description into an enum's VALUES", () => {
    // The lossy layer is what makes the schema-position walk load-bearing: an
    // enum entry that happens to be an object is data the model must send back
    // verbatim, and a `description` folded into it would corrupt the tool call.
    const out = forGemini(objectWith("shape", { enum: [{ minLength: 3 }] }));
    expect(propertyOf(out, "shape")).toEqual({ enum: [{ minLength: 3 }] });
  });

  test("returns a schema the subset already accepts by IDENTITY", () => {
    // Nine rules run over every node and none of them may allocate when the
    // node has nothing to rewrite.
    const clean: JSONSchema7 = {
      type: "object",
      properties: { path: { type: "string" }, depth: { type: "integer" } },
      required: ["path"],
    };
    expect(forGemini(clean)).toBe(clean);
  });
});
