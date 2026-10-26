// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { agent, tool } from "./define.ts";
import { parseSchemaInput, parseToolInput, schemaInputIssues, toolInputIssues } from "./testing.ts";
import { withTools } from "./tool-registry.ts";

const addPizza = tool({
  description: "Add a pizza",
  inputSchema: z.object({
    size: z.enum(["small", "large"]),
    quantity: z.number().int().positive().default(1),
  }),
  execute: (args) => args,
});

/** A tool that takes no arguments at all — the case that must not read as "accepted". */
const viewOrder = tool({ description: "View the order", execute: () => ({}) });

/**
 * Lowered once, so a failure can name each def by the name its agent
 * registered it under — the pairing `virtual:aai/agent` records the same way.
 */
withTools(agent({ name: "Schema Fixtures" }), { add_pizza: addPizza, view_order: viewOrder });

/** Built inline and never lowered: it has no name, only a description. */
const inline = tool({
  description: "Pick a seat",
  inputSchema: z.object({ row: z.number().int() }),
  execute: ({ row }) => row,
});

describe("parseSchemaInput", () => {
  test("returns the PARSED value, defaults applied", async () => {
    // The reason the positive case wants the value rather than the issues: the
    // thing worth asserting is usually what the schema FILLED IN.
    const parsed = await parseSchemaInput<{ quantity: number }>(addPizza.inputSchema, {
      size: "small",
    });
    expect(parsed.quantity).toBe(1);
  });

  test("throws with every issue rendered on one line", async () => {
    // A raw issue array prints as `[Object]`, which is what makes a hand-rolled
    // version's failure unreadable.
    await expect(
      parseSchemaInput(addPizza.inputSchema, { size: "enormous", quantity: 0 }, "add_pizza"),
    ).rejects.toThrow(/^add_pizza refused that input: .+; .+$/);
  });

  test("a missing schema is an ERROR, not a pass", async () => {
    // "This declares no schema" is a different fact from "the schema accepted
    // it", and a spec asserting the second must not be satisfied by the first.
    await expect(parseSchemaInput(undefined, {}, "the workflow input")).rejects.toThrow(
      "the workflow input declares no input schema",
    );
  });
});

describe("schemaInputIssues", () => {
  test("undefined when the schema accepts, issues when it does not", async () => {
    expect(await schemaInputIssues(addPizza.inputSchema, { size: "large" })).toBeUndefined();
    const issues = await schemaInputIssues(addPizza.inputSchema, { size: "enormous" });
    expect(issues).toBeDefined();
    expect(issues?.[0]?.message).toEqual(expect.any(String));
  });

  test("a missing schema throws here too, for the same reason", async () => {
    await expect(schemaInputIssues(undefined, {})).rejects.toThrow(
      "the schema declares no input schema",
    );
  });
});

describe("parseToolInput", () => {
  test("validates against the def's schema and answers the PARSED value, typed by it", async () => {
    const parsed = await parseToolInput(addPizza, { size: "small", quantity: 3 });
    expect(parsed.quantity).toBe(3);
    // The schema's own default — what the positive case wants the value for.
    expect((await parseToolInput(addPizza, { size: "large" })).quantity).toBe(1);
  });

  test("a refusal names the TOOL by its registered name, not just 'the schema'", async () => {
    await expect(parseToolInput(addPizza, { size: "enormous" })).rejects.toThrow(
      /^Tool add_pizza refused that input:/,
    );
  });

  test("a def no agent lowered is named by its description rather than refused", async () => {
    // The schema is on the def, so nothing here needs the registry: an inline
    // def is as valid a subject as a lowered one, and the message still says
    // WHICH tool.
    expect(await parseToolInput(inline, { row: 4 })).toEqual({ row: 4 });
    await expect(parseToolInput(inline, { row: "four" })).rejects.toThrow(
      /^The tool \(described as "Pick a seat"\) refused that input:/,
    );
  });

  test("a tool that declares no inputSchema says so rather than crashing", async () => {
    // `undefined["~standard"]` names the property rather than the problem.
    await expect(parseToolInput(viewOrder, {})).rejects.toThrow(
      "Tool view_order declares no input schema",
    );
  });
});

describe("toolInputIssues", () => {
  test("is the negative half — the assertion behind 'the schema refuses that'", async () => {
    expect(await toolInputIssues(addPizza, { size: "small" })).toBeUndefined();
    expect(await toolInputIssues(addPizza, { size: "enormous" })).toBeDefined();
    expect(await toolInputIssues(inline, { row: 1.5 })).toBeDefined();
  });

  test("a tool with no schema throws rather than answering 'no issues'", async () => {
    // Answering `undefined` would read as "accepted", which is the one wrong
    // answer available here.
    await expect(toolInputIssues(viewOrder, { anything: true })).rejects.toThrow(
      "declares no input schema",
    );
  });
});
