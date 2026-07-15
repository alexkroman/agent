// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { createMockToolContext } from "./_test-utils.ts";
import { resolveAllBuiltins } from "./builtin-tools.ts";

/**
 * Invoke the host-side run_code def. run_code no longer executes on the host —
 * real execution happens inside the guest sandbox (see deno-harness). This
 * host-side def is a guard that refuses to evaluate code.
 */
function runCode(code: string): Promise<unknown> {
  const { defs } = resolveAllBuiltins(["run_code"]);
  return defs.run_code?.execute({ code }, createMockToolContext()) as Promise<unknown>;
}

describe("resolveAllBuiltins schemas", () => {
  test("returns requested tools", () => {
    const { schemas } = resolveAllBuiltins([
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
    const { schemas } = resolveAllBuiltins([]);
    expect(schemas).toHaveLength(0);
  });

  test("unknown tool name returns empty", () => {
    const { schemas } = resolveAllBuiltins(["nonexistent_tool"]);
    expect(schemas).toHaveLength(0);
  });
});

describe("resolveAllBuiltins defs", () => {
  test("returns tool defs with execute functions", () => {
    const { defs } = resolveAllBuiltins(["web_search", "fetch_json"]);
    expect(Object.keys(defs)).toEqual(["web_search", "fetch_json"]);
    expect(defs.web_search?.execute).toBeTypeOf("function");
    expect(defs.fetch_json?.execute).toBeTypeOf("function");
  });

  test("unknown tool name is skipped", () => {
    const { defs } = resolveAllBuiltins(["nonexistent_tool"]);
    expect(Object.keys(defs)).toHaveLength(0);
  });

  // ─── run_code (host-side guard) ─────────────────────────────────────────
  // run_code executes untrusted JS and now runs ONLY inside the guest sandbox
  // (gVisor/Deno) — see deno-harness.test.ts for execution coverage. The
  // host-side def must never evaluate code; it returns an error instead.

  test("run_code is registered with schema and guidance", () => {
    const { defs, schemas, guidance } = resolveAllBuiltins(["run_code"]);
    expect(defs.run_code?.execute).toBeTypeOf("function");
    expect(schemas.map((s) => s.name)).toContain("run_code");
    expect(guidance.some((g) => g.includes("run_code"))).toBe(true);
  });

  test("run_code does not execute code on the host", async () => {
    const result = await runCode('console.log("hello")');
    expect(result).toEqual({
      error:
        "run_code is only available in the sandboxed runtime and cannot run in this environment.",
    });
  });

  test("run_code refuses even benign code on the host (no evaluation)", async () => {
    // A payload that WOULD have escaped the old node:vm sandbox must never be
    // evaluated on the host — the guard returns before any execution.
    const result = await runCode('console.log.constructor("return process")().env');
    expect(result).toHaveProperty("error");
    expect(result as { error: string }).not.toHaveProperty("env");
  });

  // ─── fetch_json ────────────────────────────────────────────────────────

  test("fetch_json fetches and returns JSON", async () => {
    const mockData = { name: "test", value: 42 };
    const mockFetch = () => Promise.resolve(new Response(JSON.stringify(mockData)));
    const { defs } = resolveAllBuiltins(["fetch_json"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    const result = await defs.fetch_json?.execute({ url: "https://api.example.com/data" }, ctx);
    expect(result).toEqual(mockData);
  });

  test("fetch_json returns error for non-ok response", async () => {
    const mockFetch = () =>
      Promise.resolve(new Response("", { status: 500, statusText: "Internal Server Error" }));
    const { defs } = resolveAllBuiltins(["fetch_json"], {
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
    const { defs } = resolveAllBuiltins(["fetch_json"], {
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
    const { defs } = resolveAllBuiltins(["fetch_json"], {
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
    const { defs } = resolveAllBuiltins(["fetch_json"], {
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

  test("fetch_json delegates fetch without SSRF checks — platform adapter handles it", async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const { defs } = resolveAllBuiltins(["fetch_json"], {
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    // SDK tools pass through — SSRF is enforced by the network adapter in
    // the platform sandbox and by the runtime's fetch in self-hosted mode.
    await defs.fetch_json?.execute({ url: "http://169.254.169.254/latest/meta-data/" }, ctx);
    expect(mockFetch).toHaveBeenCalled();
  });

  // ─── web_search ────────────────────────────────────────────────────────

  test("web_search returns error when BRAVE_API_KEY is not set", async () => {
    const { defs } = resolveAllBuiltins(["web_search"]);
    const ctx = createMockToolContext({ env: {} });
    const result = await defs.web_search?.execute({ query: "test" }, ctx);
    expect(result).toEqual({ error: "BRAVE_API_KEY is not set — web search unavailable" });
  });

  test("web_search returns error on non-ok response", async () => {
    const mockFetch = () =>
      Promise.resolve(new Response("", { status: 500, statusText: "Internal Server Error" }));
    const { defs } = resolveAllBuiltins(["web_search"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext({ env: { BRAVE_API_KEY: "key123" } });
    const result = await defs.web_search?.execute({ query: "test" }, ctx);
    expect(result).toEqual({ error: "Search request failed: 500 Internal Server Error" });
  });

  test("web_search returns empty results when response has no web results", async () => {
    const mockFetch = () => Promise.resolve(new Response(JSON.stringify({ invalid: true })));
    const { defs } = resolveAllBuiltins(["web_search"], {
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
    const { defs } = resolveAllBuiltins(["web_search"], {
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
    const { defs } = resolveAllBuiltins(["visit_webpage"], {
      fetch: mockFetch as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    const result = (await defs.visit_webpage?.execute(
      { url: "https://example.com" },
      ctx,
    )) as Record<string, unknown>;
    expect(result.url).toBe("https://example.com");
    expect(result.content).toBeTypeOf("string");
    expect((result.content as string).length).toBeGreaterThan(0);
  });

  test("visit_webpage returns error for non-ok response", async () => {
    const mockFetch = () =>
      Promise.resolve(new Response("", { status: 404, statusText: "Not Found" }));
    const { defs } = resolveAllBuiltins(["visit_webpage"], {
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
    const { defs } = resolveAllBuiltins(["visit_webpage"], {
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

  test("visit_webpage follows redirects without re-validating target", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === "https://evil.com/redirect") {
        return new Response("<html><body>metadata: leaked-iam-creds</body></html>", {
          status: 200,
        });
      }
      return new Response("", { status: 404 });
    });
    const { defs } = resolveAllBuiltins(["visit_webpage"], {
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    const result = await defs.visit_webpage?.execute({ url: "https://evil.com/redirect" }, ctx);
    expect(result).toHaveProperty("content");
    expect((result as { content: string }).content).toContain("leaked-iam-creds");
  });
});
