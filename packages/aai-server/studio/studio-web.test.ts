// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createWebTools, webBuiltinNames } from "./studio-web.ts";

const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

describe("webBuiltinNames", () => {
  test("visit_webpage and get_page_design need no key", () => {
    expect(webBuiltinNames(env({}))).toEqual(["visit_webpage", "get_page_design"]);
  });

  test("web_search appears only when the host holds a Brave key", () => {
    // Without one the builtin can only return "BRAVE_API_KEY is not set";
    // offering a tool that can only fail wastes a turn.
    expect(webBuiltinNames(env({ BRAVE_API_KEY: "k" }))).toEqual([
      "visit_webpage",
      "get_page_design",
      "web_search",
    ]);
  });
});

describe("createWebTools", () => {
  test("exposes the builtins as AI SDK tools with descriptions", () => {
    const tools = createWebTools(env({}));
    expect(Object.keys(tools)).toEqual(["visit_webpage", "get_page_design"]);
    expect(tools.visit_webpage?.description).toMatch(/webpage/i);
    expect(tools.visit_webpage?.inputSchema).toBeDefined();
    expect(tools.get_page_design?.description).toMatch(/design/i);
    expect(tools.get_page_design?.inputSchema).toBeDefined();
  });

  test("includes web_search when configured", () => {
    expect(Object.keys(createWebTools(env({ BRAVE_API_KEY: "k" })))).toContain("web_search");
  });

  test("rejects malformed arguments instead of calling out", async () => {
    const tools = createWebTools(env({}));
    // No url: the builtin would otherwise fetch `undefined`.
    const execute = tools.visit_webpage?.execute as
      | ((args: unknown, options: unknown) => Promise<unknown>)
      | undefined;
    const result = await execute?.({}, { toolCallId: "t", messages: [] });
    expect(result).toMatchObject({ error: expect.stringContaining("Invalid arguments") });
  });
});
