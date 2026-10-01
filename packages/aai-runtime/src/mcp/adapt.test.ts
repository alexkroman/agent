// Copyright 2026 the AAI authors. MIT license.
/**
 * A `tools/call` reply into the value the model sees, and a discovered tool
 * into a `ToolDef`. The whole-surface cases are in `tools.test.ts`.
 */

import { createToolContext } from "@alexkroman1/aai/testing";
import { isToolFailure } from "@alexkroman1/aai/utils";
import { tool as aiTool, jsonSchema } from "ai";
import { describe, expect, test } from "vitest";
import { discover, mcpTool, toToolResult } from "./adapt.ts";

describe("toToolResult", () => {
  test("the server's isError wins, as a ToolFailure", () => {
    const result = toToolResult(
      { isError: true, text: "", structured: { a: 1 }, otherParts: [] },
      "mcp_x_y",
    );
    expect(isToolFailure(result)).toBe(true);
  });

  test("structured output, then text with non-text parts NAMED", () => {
    expect(
      toToolResult({ isError: false, text: "t", structured: { a: 1 }, otherParts: [] }, "n"),
    ).toEqual({ a: 1 });
    expect(toToolResult({ isError: false, text: "t", otherParts: ["image"] }, "n")).toEqual({
      text: "t",
      unsupportedContent: ["image"],
    });
    expect(toToolResult({ isError: false, text: "t", otherParts: [] }, "n")).toBe("t");
  });
});

describe("mcpTool", () => {
  test("a transport failure is a ToolFailure naming the server, never a throw", async () => {
    const remote = aiTool({
      inputSchema: jsonSchema<Record<string, never>>({ type: "object" }),
      execute: async (): Promise<string> => {
        throw new Error("socket closed");
      },
    });
    const [found] = await discover({ search: remote });
    if (!found) throw new Error("discover dropped the tool");
    const def = mcpTool(found, "docs", "mcp_docs_search");
    expect(def.description).toContain('via the "docs" MCP server');
    const result = await def.execute({}, createToolContext());
    expect(isToolFailure(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("socket closed");
  });
});
