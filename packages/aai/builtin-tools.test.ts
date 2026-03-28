// Copyright 2025 the AAI authors. MIT license.

import { createStorage } from "unstorage";
import { describe, expect, test, vi } from "vitest";
import { createMockToolContext } from "./_test-utils.ts";
import { getBuiltinToolDefs, getBuiltinToolSchemas, memoryTools } from "./builtin-tools.ts";
import { createUnstorageKv } from "./unstorage-kv.ts";

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

  // ─── run_code security: isolate prevents host access ──────────────

  test("run_code isolate blocks network access", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute(
      {
        code: `
          try {
            const res = await fetch("https://example.com");
            console.log("ESCAPED:" + res.status);
          } catch(e) {
            console.log("BLOCKED:" + e.message);
          }
        `,
      },
      ctx,
    );
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/BLOCKED/);
  });

  test("run_code isolate blocks filesystem writes", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute(
      {
        code: `
          try {
            const fs = await import("node:fs");
            fs.writeFileSync("/tmp/pwned.txt", "owned");
            console.log("ESCAPED");
          } catch(e) {
            console.log("BLOCKED:" + e.message);
          }
        `,
      },
      ctx,
    );
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/BLOCKED/);
  });

  test("run_code isolate blocks child process spawning", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute(
      {
        code: `
          try {
            const cp = await import("node:child_process");
            const out = cp.execSync("id").toString();
            console.log("ESCAPED:" + out);
          } catch(e) {
            console.log("BLOCKED:" + e.message);
          }
        `,
      },
      ctx,
    );
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/BLOCKED/);
  });

  test("run_code isolate blocks env var access", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute(
      {
        code: `
          try {
            const keys = process.env ? Object.keys(process.env) : [];
            const hasPath = keys.includes("PATH");
            const hasHome = keys.includes("HOME");
            console.log(hasPath || hasHome ? "LEAKED_ENV" : "SAFE:" + keys.length);
          } catch(e) {
            console.log("SAFE:" + e.message);
          }
        `,
      },
      ctx,
    );
    expect(typeof result).toBe("string");
    expect(result as string).not.toMatch(/LEAKED_ENV/);
  });

  test("run_code isolate prevents constructor chain escape", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    // This was the critical bypass in the old regex approach — now the isolate
    // blocks env access so host secrets can't be exfiltrated.
    const result = await defs.run_code?.execute(
      {
        code: `
          const c = "con" + "stru" + "ctor";
          const F = ""[c][c];
          try {
            const p = F("return process")();
            const keys = p && p.env ? Object.keys(p.env) : [];
            const hasPath = keys.includes("PATH");
            console.log(hasPath ? "LEAKED_ENV" : "SAFE:" + keys.length);
          } catch(e) {
            console.log("SAFE:" + e.message);
          }
        `,
      },
      ctx,
    );
    expect(typeof result).toBe("string");
    expect(result as string).not.toMatch(/LEAKED_ENV/);
  });

  test("run_code allows normal .constructor property check", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute(
      { code: 'console.log("hello".constructor.name)' },
      ctx,
    );
    expect(result).toBe("String");
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

  test("fetch_json passes allowed custom headers to fetch", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }))));
    const defs = getBuiltinToolDefs(["fetch_json"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    await defs.fetch_json?.execute(
      {
        url: "https://api.example.com",
        headers: { Accept: "application/json", "x-api-key": "tok" },
      },
      ctx,
    );
    const callArgs = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(callArgs[1]).toMatchObject({
      headers: { Accept: "application/json", "x-api-key": "tok" },
    });
  });

  test("fetch_json blocks dangerous headers like Authorization", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }))));
    const defs = getBuiltinToolDefs(["fetch_json"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    await defs.fetch_json?.execute(
      {
        url: "https://api.example.com",
        headers: { Authorization: "Bearer tok", Accept: "application/json" },
      },
      ctx,
    );
    const callArgs = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    // Authorization should be stripped, Accept should remain
    expect(callArgs[1]).toMatchObject({ headers: { Accept: "application/json" } });
    expect((callArgs[1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  // ─── web_search ────────────────────────────────────────────────────────

  test("web_search returns error when BRAVE_API_KEY is not set", async () => {
    const defs = getBuiltinToolDefs(["web_search"]);
    const ctx = createMockToolContext({ env: {} });
    const result = await defs.web_search?.execute({ query: "test" }, ctx);
    expect(result).toEqual({ error: "BRAVE_API_KEY is not set — web search unavailable" });
  });

  test("web_search returns error on non-ok response", async () => {
    const mockFetch = () =>
      Promise.resolve(new Response("", { status: 500, statusText: "Internal Server Error" }));
    const defs = getBuiltinToolDefs(["web_search"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext({ env: { BRAVE_API_KEY: "key123" } });
    const result = await defs.web_search?.execute({ query: "test" }, ctx);
    expect(result).toEqual({ error: "Search request failed: 500 Internal Server Error" });
  });

  test("web_search returns empty results when response has no web results", async () => {
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

  // ─── SSRF protection ─────────────────────────────────────────────────

  test("visit_webpage blocks requests to private IPs", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response("ok")));
    const defs = getBuiltinToolDefs(["visit_webpage"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    for (const privateUrl of [
      "http://127.0.0.1/secret",
      "http://10.0.0.1/internal",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/admin",
      "http://172.16.0.1/internal",
      "http://localhost/secret",
    ]) {
      await expect(defs.visit_webpage?.execute({ url: privateUrl }, ctx)).rejects.toThrow(
        /Blocked request to private address/,
      );
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("visit_webpage blocks redirect to private IP (SSRF bypass)", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        new Response("", {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
      ),
    );
    const defs = getBuiltinToolDefs(["visit_webpage"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    await expect(
      defs.visit_webpage?.execute({ url: "https://evil.com/redirect" }, ctx),
    ).rejects.toThrow(/Blocked request to private address/);
    // The initial fetch should have been called, but not the redirect target
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("visit_webpage follows safe redirects", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response("", {
            status: 301,
            headers: { location: "https://safe.example.com/page" },
          }),
        );
      }
      return Promise.resolve(new Response("<html><body>Final</body></html>"));
    });
    const defs = getBuiltinToolDefs(["visit_webpage"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    const result = (await defs.visit_webpage?.execute(
      { url: "https://example.com/old" },
      ctx,
    )) as Record<string, unknown>;
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(typeof result.content).toBe("string");
  });

  test("fetch_json blocks requests to private IPs", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response("{}")));
    const defs = getBuiltinToolDefs(["fetch_json"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    await expect(
      defs.fetch_json?.execute({ url: "http://169.254.169.254/latest/meta-data/" }, ctx),
    ).rejects.toThrow(/Blocked request to private address/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("fetch_json blocks redirect to private IP", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1:8080/internal" },
        }),
      ),
    );
    const defs = getBuiltinToolDefs(["fetch_json"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    await expect(defs.fetch_json?.execute({ url: "https://evil.com/api" }, ctx)).rejects.toThrow(
      /Blocked request to private address/,
    );
  });

  test("visit_webpage blocks IPv4-mapped IPv6 bypass", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response("ok")));
    const defs = getBuiltinToolDefs(["visit_webpage"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    await expect(
      defs.visit_webpage?.execute({ url: "http://[::ffff:127.0.0.1]/secret" }, ctx),
    ).rejects.toThrow(/Blocked request to private address/);
  });
});

// ─── Memory tools ────────────────────────────────────────────────────────────

describe("memoryTools", () => {
  test("save_memory saves to kv and returns key", async () => {
    const kv = createUnstorageKv({ storage: createStorage() });
    const tools = memoryTools();
    const ctx = createMockToolContext({ kv });

    const result = await tools.save_memory.execute({ key: "user:name", value: "Alice" }, ctx);
    expect(result).toEqual({ saved: "user:name" });
    expect(await kv.get("user:name")).toBe("Alice");
  });

  test("recall_memory returns found value", async () => {
    const kv = createUnstorageKv({ storage: createStorage() });
    await kv.set("test:key", "test-value");
    const tools = memoryTools();
    const ctx = createMockToolContext({ kv });

    const result = await tools.recall_memory.execute({ key: "test:key" }, ctx);
    expect(result).toEqual({ found: true, key: "test:key", value: "test-value" });
  });

  test("recall_memory returns not found for missing key", async () => {
    const kv = createUnstorageKv({ storage: createStorage() });
    const tools = memoryTools();
    const ctx = createMockToolContext({ kv });

    const result = await tools.recall_memory.execute({ key: "missing" }, ctx);
    expect(result).toEqual({ found: false, key: "missing" });
  });

  test("list_memories lists keys with prefix filter", async () => {
    const kv = createUnstorageKv({ storage: createStorage() });
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
    const kv = createUnstorageKv({ storage: createStorage() });
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
    const kv = createUnstorageKv({ storage: createStorage() });
    await kv.set("to-delete", "val");
    const tools = memoryTools();
    const ctx = createMockToolContext({ kv });

    const result = await tools.forget_memory.execute({ key: "to-delete" }, ctx);
    expect(result).toEqual({ deleted: "to-delete" });
    expect(await kv.get("to-delete")).toBeNull();
  });
});
