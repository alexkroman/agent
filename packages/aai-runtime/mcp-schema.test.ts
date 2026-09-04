// Copyright 2026 the AAI authors. MIT license.
/**
 * The adapter that lets an MCP tool's published JSON Schema be the
 * `inputSchema` `executeToolCall` validates through.
 *
 * Two claims, and the second is the security-relevant one: the document the
 * model reads is the server's own, and the one thing this side checks is the
 * one the server cannot check for us.
 */

import { tool as aiTool, jsonSchema } from "ai";
import type { JSONSchema7 } from "json-schema";
import { describe, expect, test } from "vitest";
import { MCP_SCHEMA_VENDOR, mcpInputSchema, toolInputJsonSchema } from "./mcp-schema.ts";

const DOC: JSONSchema7 = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
};

describe("toolInputJsonSchema", () => {
  test("reads the document behind an AI SDK tool's inputSchema", async () => {
    const found = aiTool({ inputSchema: jsonSchema(DOC), execute: () => "ok" });
    expect(await toolInputJsonSchema(found)).toEqual(DOC);
  });

  test("a no-argument tool resolves to the empty object schema, not to nothing", async () => {
    // What a server publishing a no-argument tool sends. It has to reach the
    // model as a declaration with `parameters`, or a provider rejects the tool
    // list — the failure would arrive from a vendor, naming neither the tool
    // nor the server.
    const found = aiTool({ inputSchema: jsonSchema({ type: "object" }), execute: () => "ok" });
    expect(await toolInputJsonSchema(found)).toEqual({ type: "object" });
  });
});

describe("mcpInputSchema", () => {
  test("hands the server's document back verbatim", () => {
    expect(mcpInputSchema(DOC, "mcp_docs_search").toJsonSchema()).toBe(DOC);
  });

  test("accepts a record of arguments unchanged — the server is what validates them", async () => {
    const schema = mcpInputSchema(DOC, "mcp_docs_search");
    // Deliberately MISSING the required `query`: this side does not re-derive
    // the server's schema, so the call reaches the server and its own complaint
    // comes back as a tool failure. See the module doc.
    expect(await schema["~standard"].validate({})).toEqual({ value: {} });
  });

  test.each([
    ["a bare string", "not an object"],
    ["an array", [1, 2]],
    ["null", null],
  ])("refuses %s, naming the tool the model called", async (_label, sent) => {
    const schema = mcpInputSchema(DOC, "mcp_docs_search");
    const result = await schema["~standard"].validate(sent);
    expect(result.issues?.[0]?.message).toContain("mcp_docs_search takes an object of arguments");
  });

  test("reports its own vendor, so a failure is attributable", () => {
    expect(mcpInputSchema(DOC, "x")["~standard"].vendor).toBe(MCP_SCHEMA_VENDOR);
  });
});
