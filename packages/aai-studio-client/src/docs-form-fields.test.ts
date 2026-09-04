// Copyright 2026 the AAI authors. MIT license.
// The form-field mapping: which control a declared property renders as, and
// what an HTTP caller sends for it.
//
// Two things here are wrong in a way no screenshot shows, which is why they are
// asserted directly rather than through a render.
//
// **The classification is `<WorkflowFields>`'s own, asked rather than copied.**
// `classify` is an adapter over `fieldKindFor` (`@alexkroman1/aai-ui`), so what
// is left to assert here is the ADAPTATION — that a property named in the
// workflow's `uploads` array reaches the rule as an upload — plus a few
// end-to-end cases, kept because they are what a reader of this pane checks
// and they cost nothing. The ORDER is specced beside the rule
// (`aai-ui/src/workflow-field-kind.test.ts`), which is where it belongs now:
// this file used to pin it because a drifting copy lived here.
//
// **And a table that quietly lost a row still renders.** Every control has to
// be on it whether or not this agent declares one, so the count is pinned: a
// vocabulary that stopped listing `<CheckboxField>` would teach that the API
// cannot take a boolean, and nothing about the page would look broken.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import { classifiedFields, classify, fieldsWorkflow, formElements } from "./docs-form-fields.ts";

/** A workflow as `GET /workflows` lists one. */
function workflow(name: string, inputSchema?: unknown, uploads?: readonly string[]) {
  return { name, ...omitUndefined({ inputSchema, uploads }) };
}

/** An object schema over the given properties. */
function schema(properties: Record<string, unknown>) {
  return { type: "object", properties };
}

const EVERY_SHAPE = workflow(
  "publish",
  schema({
    topic: { type: "string" },
    count: { type: "integer" },
    ratio: { type: "number" },
    tone: { enum: ["formal", "casual"] },
    draft: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
    meta: { type: "object" },
    cover: { type: "string" },
  }),
  ["cover"],
);

describe("classify", () => {
  test("picks the control <WorkflowFields> would render", () => {
    expect(classify("topic", { type: "string" }, [])).toBe("text");
    expect(classify("count", { type: "integer" }, [])).toBe("number");
    expect(classify("ratio", { type: "number" }, [])).toBe("number");
    expect(classify("draft", { type: "boolean" }, [])).toBe("checkbox");
    expect(classify("tone", { enum: ["formal", "casual"] }, [])).toBe("select");
    expect(classify("tags", { type: "array" }, [])).toBe("none");
    expect(classify("meta", { type: "object" }, [])).toBe("none");
  });

  test("passes the UPLOAD declaration through, from the array it walks", () => {
    // This is the adaptation, and the whole of what this module adds: the rule
    // takes a boolean, the pane holds the workflow's `uploads` LIST, and a
    // property missing from it must not reach the rule as an upload. Reading
    // the type instead would call an upload property a text field — the pane
    // would document typing an id no caller can produce, which is exactly the
    // inference this card exists to correct.
    expect(classify("cover", { type: "string" }, ["cover"])).toBe("file");
    expect(classify("cover", { type: "string" }, ["other"])).toBe("text");
    expect(classify("cover", { type: "string" }, [])).toBe("text");
  });

  test("prefers an enum to the type, and takes the first non-null of a union", () => {
    // A nullable string is what `z.string().nullable()` converts to, and it is
    // still a text box.
    expect(classify("topic", { type: ["string", "null"] }, [])).toBe("text");
    expect(classify("count", { type: ["null", "integer"] }, [])).toBe("number");
    // An enum with a type beside it is still a dropdown.
    expect(classify("tone", { type: "string", enum: ["formal"] }, [])).toBe("select");
  });

  test("and anything it cannot read is `none` rather than a guess", () => {
    // `none` means "no generated control", which the pane says out loud. A
    // guess here would render a box whose value the schema then rejects.
    expect(classify("mystery", undefined, [])).toBe("none");
    expect(classify("mystery", {}, [])).toBe("none");
    expect(classify("mystery", { enum: [] }, [])).toBe("none");
  });
});

describe("classifiedFields", () => {
  test("keeps DECLARATION order and pairs each property with its sent value", () => {
    // Declaration order, because the annotated snippet is read beside the form
    // it describes. The values come from the pane's own sampler, so this and
    // the compact run body cannot disagree about a field.
    expect(classifiedFields(EVERY_SHAPE).map((field) => [field.property, field.kind])).toEqual([
      ["topic", "text"],
      ["count", "number"],
      ["ratio", "number"],
      ["tone", "select"],
      ["draft", "checkbox"],
      ["tags", "none"],
      ["meta", "none"],
      ["cover", "file"],
    ]);
    const values = Object.fromEntries(
      classifiedFields(EVERY_SHAPE).map((field) => [field.property, field.value]),
    );
    expect(values).toMatchObject({
      topic: '"<topic>"',
      count: "0",
      draft: "false",
      // A real, legal value rather than a placeholder — the whole point of
      // sampling an enum's first member.
      tone: '"formal"',
      // A handle, and a TERSE one: the row already names the property.
      cover: '"<upload id>"',
    });
  });

  test("reports nothing for a workflow that declared no schema", () => {
    // A real shape — input is optional — and what makes the annotated snippet
    // absent rather than an empty literal somebody reads as unfinished.
    expect(classifiedFields(workflow("digest"))).toEqual([]);
    expect(classifiedFields(workflow("digest", { type: "object" }))).toEqual([]);
  });
});

describe("formElements", () => {
  test("lists every control, declared or not", () => {
    // The deliberate exception to the pane's show-only-what-is-true rule: the
    // vocabulary IS the answer to "what can I send", so a row is never dropped
    // for want of an example. Pinned as a count because a vocabulary that
    // silently lost one still renders a perfectly healthy-looking table.
    const rows = formElements([EVERY_SHAPE]);
    expect(rows.map((row) => row.kind)).toEqual([
      "text",
      "textarea",
      "number",
      "select",
      "checkbox",
      "file",
      "none",
    ]);
    // Every row carries all three columns and the caller-facing note.
    for (const row of rows) {
      expect(row.element).toBeTruthy();
      expect(row.schema).toBeTruthy();
      expect(row.value).toBeTruthy();
      expect(row.note).toBeTruthy();
    }
  });

  test("carries THIS agent's own property where it declares one of that shape", () => {
    const rows = new Map(formElements([EVERY_SHAPE]).map((row) => [row.kind, row]));
    expect(rows.get("text")).toMatchObject({ property: "topic", declared: true });
    expect(rows.get("number")).toMatchObject({ property: "count", declared: true });
    expect(rows.get("select")).toMatchObject({ property: "tone", value: '"formal"' });
    expect(rows.get("file")).toMatchObject({ property: "cover", declared: true });
    // Which workflow it came from, because an agent may declare several and a
    // field name with no owner is a name the reader has to go looking for.
    expect(rows.get("text")?.workflow).toBe("publish");
  });

  test("never matches a TEXTAREA, which is the same string over the wire", () => {
    // Otherwise one property appears on two rows claiming to be two controls,
    // and only one of them is what the generated form renders.
    const textarea = formElements([EVERY_SHAPE]).find((row) => row.kind === "textarea");
    expect(textarea?.declared).toBe(false);
    expect(textarea?.workflow).toBeUndefined();
  });

  test("falls back to a placeholder, and SAYS it is one", () => {
    // A placeholder read as a real field name is how somebody pastes a 400, so
    // `declared` is what the row renders the distinction from.
    const rows = new Map(
      formElements([workflow("digest", schema({ topic: { type: "string" } }))]).map((row) => [
        row.kind,
        row,
      ]),
    );
    expect(rows.get("text")).toMatchObject({ property: "topic", declared: true });
    expect(rows.get("checkbox")).toMatchObject({ property: "draft", declared: false });
    expect(rows.get("file")).toMatchObject({ property: "recording", declared: false });
  });

  test("takes the FIRST match, in listing then declaration order", () => {
    // The same order the run examples above the table are generated in, so a
    // field name a reader recognises here is in the snippet they just read.
    const rows = new Map(
      formElements([
        workflow("first", schema({ alpha: { type: "string" } })),
        workflow("second", schema({ beta: { type: "string" }, flag: { type: "boolean" } })),
      ]).map((row) => [row.kind, row]),
    );
    expect(rows.get("text")).toMatchObject({ property: "alpha", workflow: "first" });
    expect(rows.get("checkbox")).toMatchObject({ property: "flag", workflow: "second" });
  });
});

describe("fieldsWorkflow", () => {
  test("picks the workflow declaring the most fields", () => {
    // A REAL workflow, so the annotated body is pastable: one synthesized from
    // every kind would mix two workflows' properties and 400 on the first one
    // the schema does not know.
    const small = workflow("small", schema({ topic: { type: "string" } }));
    expect(fieldsWorkflow([small, EVERY_SHAPE])?.name).toBe("publish");
    expect(fieldsWorkflow([EVERY_SHAPE, small])?.name).toBe("publish");
  });

  test("keeps the first on a tie", () => {
    const one = workflow("one", schema({ a: { type: "string" } }));
    const two = workflow("two", schema({ b: { type: "string" } }));
    expect(fieldsWorkflow([one, two])?.name).toBe("one");
  });

  test("and is absent when nothing declares a schema", () => {
    expect(fieldsWorkflow([])).toBeUndefined();
    expect(fieldsWorkflow([workflow("digest")])).toBeUndefined();
  });
});
