// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createMockToolContext } from "./_test_utils.ts";
import { getBuiltinToolDefs, getBuiltinToolSchemas, memoryTools } from "./builtin_tools.ts";
import { createMemoryKv } from "./kv.ts";

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
    expect(schemas[0]?.name).toBe("vector_search");
  });

  test("memory expands to 4 tools", () => {
    const schemas = getBuiltinToolSchemas(["memory"]);
    expect(schemas).toHaveLength(4);
    const names = schemas.map((s) => s.name);
    expect(names).toContain("save_memory");
    expect(names).toContain("recall_memory");
    expect(names).toContain("list_memories");
    expect(names).toContain("forget_memory");
  });

  test("unknown tool name returns empty", () => {
    const schemas = getBuiltinToolSchemas(["nonexistent_tool"]);
    expect(schemas).toHaveLength(0);
  });
});

describe("getBuiltinToolDefs", () => {
  test("returns tool defs with execute functions", () => {
    const defs = getBuiltinToolDefs(["web_search", "fetch_json"]);
    expect(Object.keys(defs)).toEqual(["web_search", "fetch_json"]);
    expect(typeof defs.web_search?.execute).toBe("function");
    expect(typeof defs.fetch_json?.execute).toBe("function");
  });

  test("unknown tool name is skipped", () => {
    const defs = getBuiltinToolDefs(["nonexistent_tool"]);
    expect(Object.keys(defs)).toHaveLength(0);
  });

  // ─── run_code ──────────────────────────────────────────────────────────

  test("run_code executes and returns stdout", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute({ code: 'console.log("hello")' }, ctx);
    expect(result).toBe("hello");
  });

  test("run_code returns error for syntax errors", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute({ code: "%%%" }, ctx);
    expect(result).toHaveProperty("error");
  });

  test("run_code returns no-output message for silent code", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute({ code: "const x = 1 + 1;" }, ctx);
    expect(result).toBe("Code ran successfully (no output)");
  });

  test("run_code captures console.warn and console.error", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute(
      {
        code: 'console.warn("w"); console.error("e"); console.debug("d"); console.info("i")',
      },
      ctx,
    );
    expect(result).toBe("w\ne\nd\ni");
  });

  // ─── fetch_json ────────────────────────────────────────────────────────

  test("fetch_json fetches and returns JSON", async () => {
    const mockData = { name: "test", value: 42 };
    const mockFetch = () => Promise.resolve(new Response(JSON.stringify(mockData)));
    const defs = getBuiltinToolDefs(["fetch_json"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    const result = await defs.fetch_json?.execute({ url: "https://api.example.com/data" }, ctx);
    expect(result).toEqual(mockData);
  });

  test("fetch_json returns error for non-ok response", async () => {
    const mockFetch = () =>
      Promise.resolve(new Response("", { status: 500, statusText: "Internal Server Error" }));
    const defs = getBuiltinToolDefs(["fetch_json"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    const result = await defs.fetch_json?.execute({ url: "https://api.example.com/fail" }, ctx);
    expect(result).toEqual({
      error: "HTTP 500 Internal Server Error",
      url: "https://api.example.com/fail",
    });
  });

  test("fetch_json returns error for invalid JSON response", async () => {
    const mockFetch = () => Promise.resolve(new Response("not-json"));
    const defs = getBuiltinToolDefs(["fetch_json"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    const result = await defs.fetch_json?.execute({ url: "https://api.example.com/text" }, ctx);
    expect(result).toEqual({
      error: "Response was not valid JSON",
      url: "https://api.example.com/text",
    });
  });

  test("fetch_json passes custom headers to fetch", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }))));
    const defs = getBuiltinToolDefs(["fetch_json"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    await defs.fetch_json?.execute(
      { url: "https://api.example.com", headers: { Authorization: "Bearer tok" } },
      ctx,
    );
    const callArgs = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(callArgs[1]).toMatchObject({ headers: { Authorization: "Bearer tok" } });
  });

  // ─── web_search ────────────────────────────────────────────────────────

  test("web_search returns error when BRAVE_API_KEY is not set", async () => {
    const defs = getBuiltinToolDefs(["web_search"]);
    const ctx = createMockToolContext({ env: {} });
    const result = await defs.web_search?.execute({ query: "test" }, ctx);
    expect(result).toEqual({ error: "BRAVE_API_KEY is not set — web search unavailable" });
  });

  test("web_search returns empty array on non-ok response", async () => {
    const mockFetch = () => Promise.resolve(new Response("", { status: 500 }));
    const defs = getBuiltinToolDefs(["web_search"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext({ env: { BRAVE_API_KEY: "key123" } });
    const result = await defs.web_search?.execute({ query: "test" }, ctx);
    expect(result).toEqual([]);
  });

  test("web_search returns empty array when response doesn't match schema", async () => {
    const mockFetch = () => Promise.resolve(new Response(JSON.stringify({ invalid: true })));
    const defs = getBuiltinToolDefs(["web_search"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext({ env: { BRAVE_API_KEY: "key123" } });
    const result = await defs.web_search?.execute({ query: "test" }, ctx);
    expect(result).toEqual([]);
  });

  test("web_search returns results from Brave API", async () => {
    const braveResponse = {
      web: {
        results: [
          { title: "Result 1", url: "https://example.com/1", description: "Desc 1" },
          { title: "Result 2", url: "https://example.com/2", description: "Desc 2" },
        ],
      },
    };
    const mockFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(braveResponse))));
    const defs = getBuiltinToolDefs(["web_search"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext({ env: { BRAVE_API_KEY: "key123" } });
    const result = await defs.web_search?.execute({ query: "test", max_results: 2 }, ctx);
    expect(result).toEqual([
      { title: "Result 1", url: "https://example.com/1", description: "Desc 1" },
      { title: "Result 2", url: "https://example.com/2", description: "Desc 2" },
    ]);
    // Check correct URL construction
    const fetchUrl = (mockFetch.mock.calls[0] as unknown as [string])[0];
    expect(fetchUrl).toContain("q=test");
    expect(fetchUrl).toContain("count=2");
  });

  // ─── visit_webpage ─────────────────────────────────────────────────────

  test("visit_webpage returns content for successful fetch", async () => {
    const html = "<html><body><p>Hello World</p></body></html>";
    const mockFetch = () => Promise.resolve(new Response(html));
    const defs = getBuiltinToolDefs(["visit_webpage"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    const result = (await defs.visit_webpage?.execute(
      { url: "https://example.com" },
      ctx,
    )) as Record<string, unknown>;
    expect(result.url).toBe("https://example.com");
    expect(typeof result.content).toBe("string");
    expect((result.content as string).length).toBeGreaterThan(0);
  });

  test("visit_webpage returns error for non-ok response", async () => {
    const mockFetch = () =>
      Promise.resolve(new Response("", { status: 404, statusText: "Not Found" }));
    const defs = getBuiltinToolDefs(["visit_webpage"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    const result = await defs.visit_webpage?.execute({ url: "https://example.com/missing" }, ctx);
    expect(result).toEqual({
      error: "Failed to fetch: 404 Not Found",
      url: "https://example.com/missing",
    });
  });

  test("visit_webpage truncates content exceeding MAX_PAGE_CHARS", async () => {
    // MAX_PAGE_CHARS is 10_000. Create content that, when converted from HTML,
    // will exceed that limit.
    const longText = "A".repeat(15_000);
    const html = `<html><body><p>${longText}</p></body></html>`;
    const mockFetch = () => Promise.resolve(new Response(html));
    const defs = getBuiltinToolDefs(["visit_webpage"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    const result = (await defs.visit_webpage?.execute(
      { url: "https://example.com" },
      ctx,
    )) as Record<string, unknown>;
    expect((result.content as string).length).toBeLessThanOrEqual(10_000);
    expect(result.truncated).toBe(true);
    expect(typeof result.totalChars).toBe("number");
  });

  // ─── vector_search ─────────────────────────────────────────────────────

  test("vector_search requires callback", () => {
    const withoutCb = getBuiltinToolDefs(["vector_search"]);
    expect(withoutCb.vector_search).toBeUndefined();

    const withCb = getBuiltinToolDefs(["vector_search"], {
      vectorSearch: async () => "results",
    });
    expect(withCb.vector_search).toBeDefined();
  });

  test("vector_search calls callback with correct args", async () => {
    const vectorSearch = vi.fn(async () => "search results");
    const defs = getBuiltinToolDefs(["vector_search"], { vectorSearch });
    const ctx = createMockToolContext();
    const result = await defs.vector_search?.execute({ query: "my query", topK: 3 }, ctx);
    expect(vectorSearch).toHaveBeenCalledWith("my query", 3);
    expect(result).toBe("search results");
  });

  test("vector_search uses default topK of 5", async () => {
    const vectorSearch = vi.fn(async () => "results");
    const defs = getBuiltinToolDefs(["vector_search"], { vectorSearch });
    const ctx = createMockToolContext();
    await defs.vector_search?.execute({ query: "q" }, ctx);
    expect(vectorSearch).toHaveBeenCalledWith("q", 5);
  });
});

// ─── Memory tools ────────────────────────────────────────────────────────────

describe("memoryTools", () => {
  test("save_memory saves to kv and returns key", async () => {
    const kv = createMemoryKv();
    const tools = memoryTools();
    const ctx = createMockToolContext({ kv });

    const result = await tools.save_memory.execute({ key: "user:name", value: "Alice" }, ctx);
    expect(result).toEqual({ saved: "user:name" });
    expect(await kv.get("user:name")).toBe("Alice");
  });

  test("recall_memory returns found value", async () => {
    const kv = createMemoryKv();
    await kv.set("test:key", "test-value");
    const tools = memoryTools();
    const ctx = createMockToolContext({ kv });

    const result = await tools.recall_memory.execute({ key: "test:key" }, ctx);
    expect(result).toEqual({ found: true, key: "test:key", value: "test-value" });
  });

  test("recall_memory returns not found for missing key", async () => {
    const kv = createMemoryKv();
    const tools = memoryTools();
    const ctx = createMockToolContext({ kv });

    const result = await tools.recall_memory.execute({ key: "missing" }, ctx);
    expect(result).toEqual({ found: false, key: "missing" });
  });

  test("list_memories lists keys with prefix filter", async () => {
    const kv = createMemoryKv();
    await kv.set("user:name", "Alice");
    await kv.set("user:age", "30");
    await kv.set("project:id", "123");
    const tools = memoryTools();
    const ctx = createMockToolContext({ kv });

    const result = (await tools.list_memories.execute({ prefix: "user:" }, ctx)) as {
      count: number;
      keys: string[];
    };
    expect(result.count).toBe(2);
    expect(result.keys).toContain("user:name");
    expect(result.keys).toContain("user:age");
    expect(result.keys).not.toContain("project:id");
  });

  test("list_memories lists all keys with empty prefix", async () => {
    const kv = createMemoryKv();
    await kv.set("a", "1");
    await kv.set("b", "2");
    const tools = memoryTools();
    const ctx = createMockToolContext({ kv });

    const result = (await tools.list_memories.execute({}, ctx)) as {
      count: number;
      keys: string[];
    };
    expect(result.count).toBe(2);
  });

  test("forget_memory deletes from kv", async () => {
    const kv = createMemoryKv();
    await kv.set("to-delete", "val");
    const tools = memoryTools();
    const ctx = createMockToolContext({ kv });

    const result = await tools.forget_memory.execute({ key: "to-delete" }, ctx);
    expect(result).toEqual({ deleted: "to-delete" });
    expect(await kv.get("to-delete")).toBeNull();
  });
});
