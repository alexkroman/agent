// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { getBuiltinToolDefs, getBuiltinToolSchemas } from "./builtin_tools.ts";

describe("getBuiltinToolSchemas", () => {
  test("returns requested tools", () => {
    const schemas = getBuiltinToolSchemas([
      "web_search",
      "visit_webpage",
      "run_code",
      "fetch_json",
    ]);
    expect(schemas).toHaveLength(4);
    const names = schemas.map((s) => s.name);
    expect(names).toContain("web_search");
    expect(names).toContain("visit_webpage");
    expect(names).toContain("run_code");
    expect(names).toContain("fetch_json");
  });

  test("returns empty for no tools", () => {
    const schemas = getBuiltinToolSchemas([]);
    expect(schemas).toHaveLength(0);
  });

  test("includes vector_search when present", () => {
    const schemas = getBuiltinToolSchemas(["vector_search"]);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.name).toBe("vector_search");
  });
});

describe("getBuiltinToolDefs", () => {
  test("returns tool defs with execute functions", () => {
    const defs = getBuiltinToolDefs(["web_search", "fetch_json"]);
    expect(Object.keys(defs)).toEqual(["web_search", "fetch_json"]);
    expect(typeof defs.web_search!.execute).toBe("function");
    expect(typeof defs.fetch_json!.execute).toBe("function");
  });

  test("run_code executes and returns stdout", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = { sessionId: "test", env: {}, state: {}, kv: {} as never, messages: [] };
    const result = await defs.run_code!.execute({ code: 'console.log("hello")' }, ctx);
    expect(result).toBe("hello");
  });

  test("run_code returns error for syntax errors", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = { sessionId: "test", env: {}, state: {}, kv: {} as never, messages: [] };
    const result = await defs.run_code!.execute({ code: "%%%" }, ctx);
    expect(result).toHaveProperty("error");
  });

  test("run_code returns no-output message for silent code", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = { sessionId: "test", env: {}, state: {}, kv: {} as never, messages: [] };
    const result = await defs.run_code!.execute({ code: "const x = 1 + 1;" }, ctx);
    expect(result).toBe("Code ran successfully (no output)");
  });

  test("fetch_json fetches and returns JSON", async () => {
    const mockData = { name: "test", value: 42 };
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify(mockData))));
    try {
      const defs = getBuiltinToolDefs(["fetch_json"]);
      const ctx = { sessionId: "test", env: {}, state: {}, kv: {} as never, messages: [] };
      const result = await defs.fetch_json!.execute({ url: "https://api.example.com/data" }, ctx);
      expect(result).toEqual(mockData);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("vector_search requires callback", () => {
    const withoutCb = getBuiltinToolDefs(["vector_search"]);
    expect(withoutCb.vector_search).toBeUndefined();

    const withCb = getBuiltinToolDefs(["vector_search"], {
      vectorSearch: async () => "results",
    });
    expect(withCb.vector_search).toBeDefined();
  });
});
