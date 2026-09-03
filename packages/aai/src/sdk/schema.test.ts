// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  formatSchemaIssues,
  isConvertibleSchema,
  type StandardSchemaV1,
  toToolJsonSchema,
} from "./schema.ts";
import { isRecord } from "./utils.ts";

/** Minimal non-Zod Standard Schema with an ArkType-style converter. */
function fakeArk(): StandardSchemaV1 & { toJsonSchema: () => Record<string, unknown> } {
  return {
    "~standard": {
      version: 1,
      vendor: "arktype",
      validate: (value: unknown) =>
        isRecord(value) ? { value } : { issues: [{ message: "must be an object" }] },
    },
    toJsonSchema: () => ({ $schema: "x", type: "object" }),
  };
}

describe("isConvertibleSchema", () => {
  test("accepts a Zod v4 schema instance", () => {
    expect(isConvertibleSchema(z.object({ n: z.number() }))).toBe(true);
  });

  test("accepts a Standard Schema with a toJsonSchema method", () => {
    expect(isConvertibleSchema(fakeArk())).toBe(true);
  });

  test("rejects zod's own toJSONSchema() OUTPUT", () => {
    // zod 4.4 stamps `~standard` (vendor "zod") onto its plain JSON Schema
    // output too — converting that would crash. The `_zod` instance marker
    // is what separates a schema from its serialization.
    const plain = z.toJSONSchema(z.object({ n: z.number() }));
    expect(isConvertibleSchema(plain)).toBe(false);
  });

  test("rejects plain objects and primitives", () => {
    expect(isConvertibleSchema({ type: "object" })).toBe(false);
    expect(isConvertibleSchema("nope")).toBe(false);
    expect(isConvertibleSchema(null)).toBe(false);
  });
});

describe("toToolJsonSchema", () => {
  test("converts Zod natively and strips the dialect URI", () => {
    const out = toToolJsonSchema(z.object({ n: z.number() })) as Record<string, unknown>;
    expect(out.$schema).toBeUndefined();
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({ n: { type: "number" } });
  });

  test("uses a vendor toJsonSchema() method when present", () => {
    const out = toToolJsonSchema(fakeArk()) as Record<string, unknown>;
    expect(out).toEqual({ type: "object" });
  });

  test('describes the CALLER\'s shape under `io: "input"` — a default is optional', () => {
    // The defect this parameter exists for. Zod's `io: "output"` describes the
    // PARSED value, where a `.default()` field is always present and therefore
    // `required` — so every defaulted field was advertised to the model as
    // mandatory, on a schema the tool would have happily defaulted.
    const schema = z.object({ query: z.string(), limit: z.number().default(10) });
    const input = toToolJsonSchema(schema, "input") as Record<string, unknown>;
    expect(input.required).toEqual(["query"]);
    // The default itself is still published, so the model can see the value it
    // gets by staying silent.
    expect(input.properties).toMatchObject({ limit: { default: 10 } });
  });

  test('describes the PRODUCER\'s shape under the default `io: "output"`', () => {
    // Pinned rather than incidental: `ctx.generate` hands its schema to the
    // model as a structured-OUTPUT contract, and a field the caller's type says
    // is present must be one the model is told to emit.
    const schema = z.object({ query: z.string(), limit: z.number().default(10) });
    const out = toToolJsonSchema(schema) as Record<string, unknown>;
    expect(out.required).toEqual(["query", "limit"]);
  });

  test("`io` caches per direction rather than per schema", () => {
    // One WeakMap keyed on the schema object would answer the second caller
    // with the first caller's direction — the two conversions of one schema are
    // different documents, not a repeat.
    const schema = z.object({ limit: z.number().default(10) });
    const first = toToolJsonSchema(schema, "input") as Record<string, unknown>;
    const second = toToolJsonSchema(schema, "output") as Record<string, unknown>;
    expect(first.required).toBeUndefined();
    expect(second.required).toEqual(["limit"]);
    // ...and still memoized within a direction.
    expect(toToolJsonSchema(schema, "input")).toBe(first);
  });

  test('`io: "input"` reports a piped field\'s INPUT type', () => {
    // `.pipe()` and `.transform()` are the other half of what `io` selects.
    // Under `"output"` the caller is told to send the POST-transform type, and
    // a bare `.transform()` cannot be represented at all — it throws, so a tool
    // declaring one was unusable rather than merely mis-described.
    const piped = z.object({ n: z.string().pipe(z.coerce.number()) });
    expect(toToolJsonSchema(piped, "input")).toMatchObject({
      properties: { n: { type: "string" } },
    });
    expect(toToolJsonSchema(piped, "output")).toMatchObject({
      properties: { n: { type: "number" } },
    });
    const transformed = z.object({ s: z.string().transform((v) => v.length) });
    expect(toToolJsonSchema(transformed, "input")).toMatchObject({
      properties: { s: { type: "string" } },
    });
    expect(() => toToolJsonSchema(transformed, "output")).toThrow(/Transforms cannot/);
  });

  test('`io: "input"` makes the author\'s unknown-key choice VISIBLE', () => {
    // Under `"output"` a plain object and a strict one convert identically —
    // both `additionalProperties: false`, because the PARSED value of either
    // really does carry no extra keys. So the advertisement said "closed" for a
    // schema that accepts an unknown key and silently drops it, and an author
    // who chose to refuse them got no different document. Under `"input"` the
    // three object modes are three answers.
    const open = z.object({ a: z.string() });
    const strict = z.strictObject({ a: z.string() });
    const loose = z.looseObject({ a: z.string() });
    expect(toToolJsonSchema(open, "input")).not.toHaveProperty("additionalProperties");
    expect(toToolJsonSchema(strict, "input")).toMatchObject({ additionalProperties: false });
    expect(toToolJsonSchema(loose, "input")).toMatchObject({ additionalProperties: {} });
    // The shape this replaced: indistinguishable.
    expect(toToolJsonSchema(open, "output")).toEqual(toToolJsonSchema(strict, "output"));
  });

  test("a vendor converter takes no direction, and says so by ignoring it", () => {
    // `toJsonSchema()` is the vendor's whole contract — there is no `io` to
    // pass — so both directions are the same document. Pinned so a caller
    // reading `io: "input"` at a call site is not misled about ArkType.
    expect(toToolJsonSchema(fakeArk(), "input")).toEqual(toToolJsonSchema(fakeArk(), "output"));
  });

  test("throws a vendor-naming error for unconvertible schemas", () => {
    const bare: StandardSchemaV1 = {
      "~standard": { version: 1, vendor: "valibot", validate: (value) => ({ value }) },
    };
    expect(() => toToolJsonSchema(bare)).toThrow(/"valibot".*toJsonSchema/s);
  });
});

describe("~standard validation / formatSchemaIssues", () => {
  test("returns the typed value on success", async () => {
    const result = await z.object({ n: z.number() })["~standard"].validate({ n: 1 });
    expect(result.issues).toBeUndefined();
    if (!result.issues) expect(result.value).toEqual({ n: 1 });
  });

  test("formats issues with dotted paths", async () => {
    const result = await z.object({ user: z.object({ id: z.string() }) })["~standard"].validate({
      user: { id: 5 },
    });
    expect(result.issues).toBeDefined();
    if (result.issues) {
      expect(formatSchemaIssues(result.issues)).toMatch(/^user\.id: /);
    }
  });

  test("formats path-less issues as the bare message", () => {
    expect(formatSchemaIssues([{ message: "must be an object" }])).toBe("must be an object");
  });

  // A union's real diagnosis lives in its per-branch `errors`, which zod passes
  // through the `~standard` interface even though the spec does not declare it.
  // Rendering only the parent issue printed `llm: Invalid input` — the field
  // name and nothing about why — for exactly the shape `AgentConfigSchema` is
  // built out of (`llm` accepts a model-id string OR a descriptor).
  test("descends into a union's per-branch issues", async () => {
    const schema = z.object({
      llm: z.union([z.string(), z.object({ kind: z.literal("openai"), model: z.string() })]),
    });
    const result = await schema["~standard"].validate({ llm: { kind: "openai" } });
    expect(result.issues).toBeDefined();
    if (!result.issues) return;
    const formatted = formatSchemaIssues(result.issues);
    // The branch that came closest names the field it was missing...
    expect(formatted).toContain("llm.model");
    // ...and every branch's path is absolute, not relative to the union.
    expect(formatted).toContain("llm: ");
    // The parent's own placeholder is never the whole answer.
    expect(formatted).not.toBe("llm: Invalid input");
  });

  test("joins union branches with `or` and dedupes identical ones", () => {
    const formatted = formatSchemaIssues([
      {
        message: "Invalid input",
        path: ["llm"],
        errors: [
          [{ message: "expected string", path: [] }],
          [{ message: "expected string", path: [] }],
          [{ message: "expected object", path: [] }],
        ],
      },
    ]);
    expect(formatted).toBe("llm: expected string or llm: expected object");
  });

  // The recursion crosses a vendor boundary, so it may not trust the shape it
  // finds there: a throw from a formatter runs inside every failure path that
  // reports one, including the platform's error handler.
  test("falls back to the parent message when `errors` is not branch-shaped", () => {
    // `errors` is typed `unknown` precisely so these need no cast: the field is
    // a vendor extension and its shape is not ours to promise.
    for (const errors of ["not an array", [], [[]], [{ nope: 1 }], null]) {
      expect(formatSchemaIssues([{ message: "Invalid input", path: ["llm"], errors }])).toBe(
        "llm: Invalid input",
      );
    }
  });
});
