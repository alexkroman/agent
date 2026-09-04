import { describe, expect, it } from "vitest";
import { fieldKindFor, schemaTypeOf, type WorkflowFieldKind } from "./workflow-field-kind.ts";

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

describe("schemaTypeOf", () => {
  it("reads a plain type and flattens a nullable union", () => {
    expect(schemaTypeOf({ type: "integer" })).toBe("integer");
    expect(schemaTypeOf({ type: ["integer", "null"] })).toBe("integer");
  });

  it("has no answer for a schema that declares none", () => {
    expect(schemaTypeOf({})).toBeUndefined();
    expect(schemaTypeOf({ type: [] })).toBeUndefined();
    expect(schemaTypeOf(undefined)).toBeUndefined();
  });
});
