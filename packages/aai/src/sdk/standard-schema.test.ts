// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { formatSchemaIssues } from "./standard-schema.ts";

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
  // `errors` is typed `unknown` precisely so these need no cast: the field is
  // a vendor extension and its shape is not ours to promise.
  test.for(["not an array", [], [[]], [{ nope: 1 }], null])(
    "falls back to the parent message when `errors` is not branch-shaped (%j)",
    (errors) => {
      expect(formatSchemaIssues([{ message: "Invalid input", path: ["llm"], errors }])).toBe(
        "llm: Invalid input",
      );
    },
  );

  // A record's KEY fails one level down: zod reports `invalid_key` with a
  // generic message of its own and nests the key schema's issues — the custom
  // `error` its author wrote included — under `issues`. Reading only the parent
  // printed `mcpServers.my-docs: Invalid key in record`, throwing away the one
  // sentence written to tell the author what a legal key is.
  test("descends into a record key's nested issues", async () => {
    const schema = z.object({
      mcpServers: z.record(
        z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, { error: "keys are lowercase and _-joined" }),
        z.object({ url: z.string() }),
      ),
    });
    const result = await schema["~standard"].validate({
      mcpServers: { "my-docs": { url: "https://a.example/mcp" } },
    });
    expect(result.issues).toBeDefined();
    if (!result.issues) return;
    expect(formatSchemaIssues(result.issues)).toBe(
      "mcpServers.my-docs: Invalid key in record — keys are lowercase and _-joined",
    );
  });

  // A cause is APPENDED where a union branch REPLACES, and this is why: the
  // path is identical for a bad key and a bad value, so the parent's message is
  // the only thing that distinguishes them. Dropping it would make the two
  // failures below indistinguishable.
  test("keeps the parent message, which is what says KEY rather than value", () => {
    const formatted = formatSchemaIssues([
      {
        message: "Invalid key in record",
        path: ["mcpServers", "my-docs"],
        issues: [{ message: "keys are lowercase", path: [] }],
      },
    ]);
    expect(formatted).toBe("mcpServers.my-docs: Invalid key in record — keys are lowercase");
    // The label is printed once, not once per level.
    expect(formatted.match(/my-docs/g)).toHaveLength(1);
  });

  test.for(["not an array", [], [{ nope: 1 }], null, 7])(
    "falls back to the parent message when `issues` is not issue-shaped (%j)",
    (issues) => {
      expect(
        formatSchemaIssues([{ message: "Invalid key in record", path: ["docs"], issues }]),
      ).toBe("docs: Invalid key in record");
    },
  );
});
