// Copyright 2026 the AAI authors. MIT license.
/**
 * What these can and cannot say: every assertion here is about the TRANSFORM.
 * There is no gateway credential in CI, so nothing below is evidence that the
 * gateway accepts the output — see the module doc, which separates the two
 * verified keywords from the layer taken from Mastra's Google compat.
 */

import type { JSONSchema7 } from "json-schema";
import { describe, expect, test } from "vitest";
import {
  GATEWAY_SCHEMA_RULES,
  GEMINI_SCHEMA_RULES,
  toolSchemaRules,
} from "./_tool-schema-compat.ts";
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

describe("the unconditional layer", () => {
  test("removes $schema from the root of a tool schema", () => {
    // Emitted by the AI SDK's zod conversion on every derived tool schema, and
    // the keyword that made 9 of the studio's 10 tools 500 on the Gemini path.
    const out = forEveryModel({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    expect(out.$schema).toBeUndefined();
    // Everything the model actually needs survives.
    expect(out).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  test("removes propertyNames from a nested property", () => {
    // How `z.record(z.string(), …)` serializes — nested, not at the root, so a
    // root-only strip would miss it.
    const out = forEveryModel(
      objectWith("args", { type: "object", propertyNames: { type: "string" } }),
    );
    expect(propertyOf(out, "args")).toEqual({ type: "object" });
  });

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

  test("keeps additionalProperties, which the gateway accepts", () => {
    // Bisected explicitly: removing `additionalProperties` did NOT fix the 500,
    // so it stays — stripping more than necessary would quietly widen what a
    // tool accepts.
    const out = forEveryModel({ type: "object", properties: {}, additionalProperties: false });
    expect(out.additionalProperties).toBe(false);
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

describe("the Gemini layer: what it removes", () => {
  test("still removes the two unconditional keywords", () => {
    const out = forGemini({ $schema: "x", type: "object", propertyNames: { type: "string" } });
    expect(out).toEqual({ type: "object" });
  });

  /** Both spellings our own conversion emits — a boolean and a value schema. */
  const additionalPropertiesCases: readonly [string, JSONSchema7["additionalProperties"]][] = [
    ["the closed-world flag from z.strictObject", false],
    ["the value schema z.record emits", { type: "number" }],
  ];

  test.each(additionalPropertiesCases)(
    "drops additionalProperties: %s",
    (_case, additionalProperties) => {
      const out = forGemini({ type: "object", properties: {}, additionalProperties });
      expect(out).toEqual({ type: "object", properties: {} });
    },
  );
});

describe("the Gemini layer: constraints that become prose", () => {
  test("folds string length into the description", () => {
    const out = forGemini(objectWith("name", { type: "string", minLength: 2, maxLength: 5 }));
    expect(propertyOf(out, "name")).toEqual({
      type: "string",
      description: "constraints: minimum length 2, maximum length 5",
    });
  });

  test("keeps an existing description and appends the constraints to it", () => {
    // The description is what the model reads to decide what to send, so a
    // fold that overwrote it would cost more than the keyword it saved.
    const out = forGemini(
      objectWith("name", { type: "string", description: "the caller's name", minLength: 2 }),
    );
    expect(propertyOf(out, "name")).toEqual({
      type: "string",
      description: "the caller's name\nconstraints: minimum length 2",
    });
  });

  test("describes an unsupported format and drops the regex zod emits beside it", () => {
    // `z.email()` converts to this pair, and the pattern opens `^(?!\.)` —
    // lookahead, which RE2 cannot compile whatever the far side does with it.
    const out = forGemini(
      objectWith("to", {
        type: "string",
        format: "email",
        pattern: "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)@x$",
      }),
    );
    expect(propertyOf(out, "to")).toEqual({
      type: "string",
      description: "constraints: a valid email",
    });
  });

  test("keeps a format Gemini documents, and still drops its redundant pattern", () => {
    const out = forGemini(
      objectWith("at", { type: "string", format: "date-time", pattern: "^\\d{4}-" }),
    );
    expect(propertyOf(out, "at")).toEqual({ type: "string", format: "date-time" });
  });

  test("describes a hand-written pattern, which is the only thing that node says", () => {
    const out = forGemini(objectWith("code", { type: "string", pattern: "^[A-Z]{3}$" }));
    expect(propertyOf(out, "code")).toEqual({
      type: "string",
      description: "constraints: matching the regular expression ^[A-Z]{3}$",
    });
  });

  test("folds every number bound into the description", () => {
    const out = forGemini(
      objectWith("n", { type: "number", minimum: 1, maximum: 9, multipleOf: 2 }),
    );
    expect(propertyOf(out, "n")).toEqual({
      type: "number",
      description:
        "constraints: greater than or equal to 1, less than or equal to 9, a multiple of 2",
    });
  });

  test("folds the exclusive bounds z.number().gt().lt() emits", () => {
    const out = forGemini(
      objectWith("n", { type: "number", exclusiveMinimum: 1, exclusiveMaximum: 9 }),
    );
    expect(propertyOf(out, "n")).toEqual({
      type: "number",
      description: "constraints: greater than 1, less than 9",
    });
  });

  test("drops the safe-integer pair SILENTLY, because it is not the author's constraint", () => {
    // `z.number().int()` converts to exactly this; describing it would put
    // "greater than or equal to -9007199254740991" in front of the model.
    const out = forGemini(
      objectWith("n", {
        type: "integer",
        minimum: Number.MIN_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      }),
    );
    expect(propertyOf(out, "n")).toEqual({ type: "integer" });
  });

  test("leaves the draft-4 boolean spelling of exclusiveMinimum alone", () => {
    // Parsed rather than written as a literal, because `JSONSchema7` cannot
    // type the draft-4 spelling at all — and a hand-written tool schema is
    // exactly where one arrives from. Reporting `greater than true` would be
    // worse than leaving a keyword our own conversion never emits.
    const draft4: JSONSchema7 = JSON.parse('{"type":"number","exclusiveMinimum":true}');
    const out = forGemini(objectWith("n", draft4));
    expect(propertyOf(out, "n")).toEqual({ type: "number", exclusiveMinimum: true });
  });

  test("folds array bounds, and states equal bounds once", () => {
    const range = forGemini(objectWith("a", { type: "array", minItems: 1, maxItems: 3 }));
    expect(propertyOf(range, "a")).toEqual({
      type: "array",
      description: "constraints: at least 1 items, at most 3 items",
    });
    const exact = forGemini(objectWith("a", { type: "array", minItems: 2, maxItems: 2 }));
    expect(propertyOf(exact, "a")).toEqual({
      type: "array",
      description: "constraints: exactly 2 items",
    });
  });

  test("folds a default, whose VALUE is the information the model needs", () => {
    const out = forGemini(objectWith("unit", { type: "string", default: "celsius" }));
    expect(propertyOf(out, "unit")).toEqual({
      type: "string",
      description: 'constraints: defaults to "celsius"',
    });
  });

  test("folds a falsy default, which a presence check is needed to see at all", () => {
    const out = forGemini(objectWith("dry", { type: "boolean", default: false }));
    expect(propertyOf(out, "dry")).toEqual({
      type: "boolean",
      description: "constraints: defaults to false",
    });
  });
});

describe("the Gemini layer: shapes restated in the subset", () => {
  test("rewrites const to a one-value enum", () => {
    const out = forGemini(objectWith("kind", { type: "string", const: "read" }));
    expect(propertyOf(out, "kind")).toEqual({ type: "string", enum: ["read"] });
  });

  test("leaves an enum alone when a const sits beside it", () => {
    // Intersecting the two is the only correct merge, and a wrong one silently
    // changes what the tool accepts.
    const out = forGemini(
      objectWith("kind", { type: "string", const: "read", enum: ["read", "write"] }),
    );
    expect(propertyOf(out, "kind")).toEqual({ type: "string", enum: ["read", "write"] });
  });

  test("rewrites oneOf to anyOf", () => {
    const out = forGemini(objectWith("mode", { oneOf: [{ type: "string" }, { type: "number" }] }));
    expect(propertyOf(out, "mode")).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  test("leaves a node carrying BOTH oneOf and anyOf alone", () => {
    const both: JSONSchema7 = { oneOf: [{ type: "string" }], anyOf: [{ type: "number" }] };
    const out = forGemini(objectWith("mode", both));
    expect(propertyOf(out, "mode")).toEqual(both);
  });

  test("collapses a nullable type array and says so in prose", () => {
    // `z.string().nullable()` — the most common of these rewrites, and the one
    // with no keyword left to live in once OpenAPI's `nullable` is refused.
    const out = forGemini(objectWith("note", { type: ["string", "null"] }));
    expect(propertyOf(out, "note")).toEqual({
      type: "string",
      description: "constraints: may be null",
    });
  });

  test("turns a multi-type union into anyOf branches", () => {
    // `z.union([z.string(), z.number()])`.
    const out = forGemini(objectWith("id", { type: ["string", "number"] }));
    expect(propertyOf(out, "id")).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  test("leaves a type array of null alone, which the subset cannot express", () => {
    const out = forGemini(objectWith("nothing", { type: ["null"] }));
    expect(propertyOf(out, "nothing")).toEqual({ type: ["null"] });
  });

  test("collapses a tuple into one items schema, keeping its arity as prose", () => {
    // `z.tuple([z.string(), z.number()])` converts to all four of these at once.
    const out = forGemini(
      objectWith("pair", {
        type: "array",
        prefixItems: [{ type: "string" }, { type: "number" }],
        items: false,
        minItems: 2,
        maxItems: 2,
      } as JSONSchema7),
    );
    expect(propertyOf(out, "pair")).toEqual({
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "number" }] },
      description: "constraints: exactly 2 items",
    });
  });

  test("a one-element tuple needs no union", () => {
    const out = forGemini(
      objectWith("solo", { type: "array", prefixItems: [{ type: "string" }] } as JSONSchema7),
    );
    expect(propertyOf(out, "solo")).toEqual({ type: "array", items: { type: "string" } });
  });

  test("keeps a real rest-items schema and drops the tuple head", () => {
    // Unioning the two would widen what each position accepts.
    const out = forGemini(
      objectWith("rest", {
        type: "array",
        prefixItems: [{ type: "string" }],
        items: { type: "number" },
      } as JSONSchema7),
    );
    expect(propertyOf(out, "rest")).toEqual({ type: "array", items: { type: "number" } });
  });

  test("removes a bare items: false, a boolean where a schema belongs", () => {
    const out = forGemini(objectWith("empty", { type: "array", items: false }));
    expect(propertyOf(out, "empty")).toEqual({ type: "array" });
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

describe("toolSchemaRules", () => {
  test.each([
    "gemini-2.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "google/gemini-2.5-pro",
    "Gemini-3.1-Flash-Lite",
  ])("selects the Gemini layer for %s", (modelId) => {
    expect(toolSchemaRules(modelId)).toBe(GEMINI_SCHEMA_RULES);
  });

  test.each(["gpt-5.2", "claude-opus-4-8", "qwen3-32B", "gpt-oss-120b", ""])(
    "selects the unconditional layer for %s",
    (modelId) => {
      expect(toolSchemaRules(modelId)).toBe(GATEWAY_SCHEMA_RULES);
    },
  );

  test("selects the unconditional layer for an absent id", () => {
    expect(toolSchemaRules(undefined)).toBe(GATEWAY_SCHEMA_RULES);
  });
});
