// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createWebTools, webBuiltinNames } from "./studio-web.ts";

describe("webBuiltinNames", () => {
  test("offers all web builtins — every one is keyless", () => {
    expect(webBuiltinNames()).toEqual(["visit_webpage", "get_page_design", "web_search"]);
  });
});

describe("createWebTools", () => {
  test("builds an executable AI SDK tool per builtin", () => {
    const tools = createWebTools();
    expect(Object.keys(tools).sort()).toEqual(["get_page_design", "visit_webpage", "web_search"]);
    for (const t of Object.values(tools)) {
      expect(t.execute).toBeTypeOf("function");
      expect(t.description).toBeTruthy();
    }
  });

  test("rejects invalid arguments as a tool-result error, not a throw", async () => {
    const tools = createWebTools();
    const result = await tools.visit_webpage?.execute?.(
      {} as never,
      { toolCallId: "t1", messages: [] } as never,
    );
    expect(result).toMatchObject({ error: expect.stringContaining("Invalid arguments") });
  });
});
