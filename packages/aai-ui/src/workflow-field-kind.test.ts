import { describe, expect, it } from "vitest";
import {
  fieldKindFor,
  nonNullSchemaOf,
  schemaChoicesOf,
  schemaTypeOf,
  type WorkflowFieldKind,
} from "./workflow-field-kind.ts";

/*
 * The three shapes below are what zod 4 (the catalog's `^4.6.5`) emits through
 * `z.toJSONSchema`, pinned against the real converter in
 * `aai-runtime/src/workflow/client.test.ts` ("the three shapes
 * `<WorkflowFields>` reads"); this package has no zod to call. A nullable enum
 * is an `anyOf` (a bare `z.string().nullable()` is the type LIST, read since
 * the start), a union of literals is an `anyOf` of `const`s, and a numeric
 * literal set is a numeric `enum`.
 */
const NULLABLE_ENUM = { anyOf: [{ type: "string", enum: ["x", "y"] }, { type: "null" }] };
const LITERAL_UNION = {
  anyOf: [
    { type: "string", const: "p" },
    { type: "string", const: "q" },
  ],
};
const NUMERIC_ENUM = { type: "number", enum: [1, 2] };

describe("fieldKindFor", () => {
  it("maps each scalar shape to its control", () => {
    expect(fieldKindFor({ type: "string" })).toBe("text");
    expect(fieldKindFor({ type: "number" })).toBe("number");
    expect(fieldKindFor({ type: "integer" })).toBe("number");
    expect(fieldKindFor({ type: "boolean" })).toBe("checkbox");
    expect(fieldKindFor({ enum: ["formal", "casual"] })).toBe("select");
  });

  /*
   * The ordering is the whole contract, and each step is written as its own
   * assertion because a reader cannot see any of it in a schema: the two
   * precedences below both involve shapes that ARE strings.
   */
  it("puts a declared upload ahead of everything", () => {
    // An upload property is a plain string in the schema — the id — so testing
    // the type first renders a text box asking for an id no person has.
    expect(fieldKindFor({ type: "string" }, { upload: true })).toBe("file");
    // And ahead of the enum too, which is the case an order-agnostic
    // implementation gets wrong without ever looking wrong.
    expect(fieldKindFor({ enum: ["a", "b"] }, { upload: true })).toBe("file");
    // Even against a shape that would otherwise have no control at all.
    expect(fieldKindFor({ type: "object" }, { upload: true })).toBe("file");
  });

  it("puts an enum ahead of the type switch", () => {
    expect(fieldKindFor({ type: "string", enum: ["formal"] })).toBe("select");
  });

  it("takes the first non-null member of a union type", () => {
    expect(fieldKindFor({ type: ["string", "null"] })).toBe("text");
    expect(fieldKindFor({ type: ["null", "integer"] })).toBe("number");
  });

  it("reads a nullable `anyOf` as its non-null member, so a required nullable enum gets a control", () => {
    // `z.enum([…]).nullable()` — REQUIRED when not also optional, so a property
    // with no control left every submission of the generated form a 400.
    expect(fieldKindFor(NULLABLE_ENUM)).toBe("select");
    expect(fieldKindFor({ anyOf: [{ type: "integer" }, { type: "null" }] })).toBe("number");
    expect(fieldKindFor({ oneOf: [{ type: "null" }, { type: "boolean" }] })).toBe("checkbox");
    expect(
      fieldKindFor({ anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] }),
    ).toBe("lines");
    // Two non-null members is some other shape: no honest control.
    expect(fieldKindFor({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("none");
  });

  it("renders a union of literals as a select over its consts", () => {
    expect(fieldKindFor(LITERAL_UNION)).toBe("select");
    expect(fieldKindFor({ anyOf: [...LITERAL_UNION.anyOf, { type: "null" }] })).toBe("select");
    // A member without a `const` is not a closed set.
    expect(fieldKindFor({ anyOf: [{ type: "string", const: "p" }, { type: "string" }] })).toBe(
      "none",
    );
  });

  it("renders an array of strings as lines, and a { name, text } object as named text", () => {
    expect(fieldKindFor({ type: "array", items: { type: "string" } })).toBe("lines");
    const namedText = {
      type: "object",
      properties: { name: { type: "string" }, text: { type: "string" } },
      required: ["name", "text"],
    };
    expect(fieldKindFor(namedText)).toBe("namedText");
    // Exactly that shape: an optional member, a third key or another type is
    // some other object, with no honest control.
    expect(fieldKindFor({ ...namedText, required: ["name"] })).toBe("none");
    expect(
      fieldKindFor({
        ...namedText,
        properties: { ...namedText.properties, size: { type: "number" } },
      }),
    ).toBe("none");
    expect(
      fieldKindFor({
        ...namedText,
        properties: { name: { type: "string" }, text: { type: "number" } },
      }),
    ).toBe("none");
    expect(fieldKindFor({ type: "array", items: { type: "number" } })).toBe("none");
  });

  it("takes the page's own render choice over the schema, but never over an upload", () => {
    expect(fieldKindFor({ type: "array" }, { render: "lines" })).toBe("lines");
    expect(fieldKindFor({ type: "object" }, { render: "namedText" })).toBe("namedText");
    expect(fieldKindFor({ type: "string" }, { render: "lines", upload: true })).toBe("file");
  });

  it("declines to guess rather than drawing a wrong control", () => {
    expect(fieldKindFor({ type: "object" })).toBe("none");
    expect(fieldKindFor({ type: "array" })).toBe("none");
    // A schema that says nothing, an EMPTY enum, and a non-object schema are
    // all "no honest control" rather than a text box.
    expect(fieldKindFor({})).toBe("none");
    expect(fieldKindFor({ enum: [] })).toBe("none");
    expect(fieldKindFor(undefined)).toBe("none");
    expect(fieldKindFor("string")).toBe("none");
  });

  it("reads `upload: false` as no declaration", () => {
    expect(fieldKindFor({ type: "string" }, { upload: false })).toBe("text");
    expect(fieldKindFor({ type: "string" }, {})).toBe("text");
  });

  it("returns only members of the published union", () => {
    const kinds: readonly WorkflowFieldKind[] = [
      "text",
      "number",
      "select",
      "checkbox",
      "file",
      "none",
    ];
    // A new control added to `<WorkflowFields>` widens the union, and every
    // reader of the rule — the studio's API pane included — finds out from the
    // type. This is the runtime half: nothing outside the union escapes.
    for (const schema of [
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { enum: ["a"] },
      { type: "object" },
    ]) {
      expect(kinds).toContain(fieldKindFor(schema));
    }
    expect(kinds).toContain(fieldKindFor({ type: "string" }, { upload: true }));
  });
});

describe("schemaChoicesOf", () => {
  it("answers the enum, or the consts of a literal union, with their own types", () => {
    expect(schemaChoicesOf({ type: "string", enum: ["x", "y"] })).toEqual(["x", "y"]);
    // Numbers stay numbers: a `<select>` of `"1"` against `z.literal([1, 2])`
    // is a refused submission, and the control has to know to read it back.
    expect(schemaChoicesOf(NUMERIC_ENUM)).toEqual([1, 2]);
    expect(schemaChoicesOf(NULLABLE_ENUM)).toEqual(["x", "y"]);
    expect(schemaChoicesOf(LITERAL_UNION)).toEqual(["p", "q"]);
    expect(schemaChoicesOf({ anyOf: [...LITERAL_UNION.anyOf, { type: "null" }] })).toEqual([
      "p",
      "q",
    ]);
  });

  it("has no answer for an open shape", () => {
    expect(schemaChoicesOf({ type: "string" })).toBeUndefined();
    expect(schemaChoicesOf({ enum: [] })).toBeUndefined();
    expect(schemaChoicesOf({ anyOf: [{ type: "string" }, { type: "number" }] })).toBeUndefined();
    expect(schemaChoicesOf(undefined)).toBeUndefined();
  });
});

describe("nonNullSchemaOf", () => {
  it("unwraps a nullable union and leaves every other shape as it is", () => {
    expect(nonNullSchemaOf(NULLABLE_ENUM)).toEqual({ type: "string", enum: ["x", "y"] });
    expect(nonNullSchemaOf({ type: "string" })).toEqual({ type: "string" });
    expect(nonNullSchemaOf(LITERAL_UNION)).toBe(LITERAL_UNION);
    expect(nonNullSchemaOf("string")).toBeUndefined();
  });
});

describe("schemaTypeOf", () => {
  it("reads a plain type and flattens a nullable union", () => {
    expect(schemaTypeOf({ type: "integer" })).toBe("integer");
    expect(schemaTypeOf({ type: ["integer", "null"] })).toBe("integer");
    // The `anyOf` spelling of the same thing.
    expect(schemaTypeOf({ anyOf: [{ type: "integer" }, { type: "null" }] })).toBe("integer");
  });

  it("has no answer for a schema that declares none", () => {
    expect(schemaTypeOf({})).toBeUndefined();
    expect(schemaTypeOf({ type: [] })).toBeUndefined();
    expect(schemaTypeOf(undefined)).toBeUndefined();
  });
});
