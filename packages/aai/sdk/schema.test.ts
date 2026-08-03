// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  formatSchemaIssues,
  isConvertibleSchema,
  type StandardSchemaV1,
  toToolJsonSchema,
} from "./schema.ts";

/** Minimal non-Zod Standard Schema with an ArkType-style converter. */
function fakeArk(): StandardSchemaV1 & { toJsonSchema: () => Record<string, unknown> } {
  return {
    "~standard": {
      version: 1,
      vendor: "arktype",
      validate: (value: unknown) =>
        typeof value === "object" && value !== null
          ? { value }
          : { issues: [{ message: "must be an object" }] },
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
});
