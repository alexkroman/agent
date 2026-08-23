// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { parseSchemaInput, parseToolInput, schemaInputIssues, toolInputIssues } from "./testing.ts";
import type { ToolDef } from "./types.ts";

const addPizza: ToolDef = {
  description: "Add a pizza",
  inputSchema: z.object({
    size: z.enum(["small", "large"]),
    quantity: z.number().int().positive().default(1),
  }),
  execute: (args) => args,
};

/** A tool that takes no arguments at all — the case that must not read as "accepted". */
const viewOrder: ToolDef = { description: "View the order", execute: () => ({}) };

const agentDef = { tools: { add_pizza: addPizza, view_order: viewOrder } };

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
  test("does the lookup, then the validation", async () => {
    const parsed = await parseToolInput<{ quantity: number }>(agentDef, "add_pizza", {
      size: "small",
      quantity: 3,
    });
    expect(parsed.quantity).toBe(3);
  });

  test("a refusal names the TOOL, not just 'the schema'", async () => {
    await expect(parseToolInput(agentDef, "add_pizza", { size: "enormous" })).rejects.toThrow(
      /^Tool add_pizza refused that input:/,
    );
  });

  test("a tool that declares no inputSchema says so rather than crashing", async () => {
    // `undefined["~standard"]` names the property rather than the problem.
    await expect(parseToolInput(agentDef, "view_order", {})).rejects.toThrow(
      "Tool view_order declares no input schema",
    );
  });

  test("a missing tool fails with toolOf's sentence, which names the ones that exist", async () => {
    await expect(parseToolInput(agentDef, "add_pizzas", {})).rejects.toThrow(
      "The agent declares no tool named add_pizzas. It declares: add_pizza, view_order.",
    );
  });
});

describe("toolInputIssues", () => {
  test("is the negative half — the assertion behind 'the schema refuses that'", async () => {
    expect(await toolInputIssues(agentDef, "add_pizza", { size: "small" })).toBeUndefined();
    expect(await toolInputIssues(agentDef, "add_pizza", { size: "enormous" })).toBeDefined();
  });

  test("a tool with no schema throws rather than answering 'no issues'", async () => {
    // Answering `undefined` would read as "accepted", which is the one wrong
    // answer available here.
    await expect(toolInputIssues(agentDef, "view_order", { anything: true })).rejects.toThrow(
      "declares no input schema",
    );
  });
});
