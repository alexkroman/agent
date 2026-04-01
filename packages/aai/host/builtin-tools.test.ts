// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { createMockToolContext } from "./_test-utils.ts";
import { executeInIsolate, getBuiltinToolDefs, getBuiltinToolSchemas } from "./builtin-tools.ts";

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

  // ─── run_code security: vm sandbox prevents host access ──────────────

  test("run_code sandbox blocks network access", async () => {
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

  test("run_code sandbox blocks filesystem writes", async () => {
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

  test("run_code sandbox blocks child process spawning", async () => {
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

  test("run_code sandbox blocks env var access", async () => {
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

  test("run_code sandbox prevents constructor chain escape", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    // This was the critical bypass in the old regex approach — the VM context
    // doesn't expose `process` so host secrets can't be exfiltrated.
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

  test("run_code sandbox blocks template literal constructor bypass", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute(
      {
        code: `
          const c = \`\${"con"}\${"stru"}\${"ctor"}\`;
          const F = ""[c][c];
          try {
            const p = F("return process")();
            const keys = p && p.env ? Object.keys(p.env) : [];
            const hasPath = keys.includes("PATH");
            console.log(hasPath ? "LEAKED_ENV" : "SAFE:" + keys.length + " keys");
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

  test("run_code sandbox blocks Array.join constructor bypass", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute(
      {
        code: `
          const c = ["con","stru","ctor"].join("");
          const F = ""[c][c];
          try {
            const p = F("return process")();
            const keys = p && p.env ? Object.keys(p.env) : [];
            const hasPath = keys.includes("PATH");
            console.log(hasPath ? "LEAKED_ENV" : "SAFE:" + keys.length + " keys");
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

  test("run_code sandbox blocks fromCharCode constructor bypass", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute(
      {
        code: `
          const s = String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114);
          const F = ""[s][s];
          try {
            const p = F("return process")();
            const keys = p && p.env ? Object.keys(p.env) : [];
            const hasPath = keys.includes("PATH");
            console.log(hasPath ? "LEAKED_ENV" : "SAFE:" + keys.length + " keys");
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

  test("run_code sandbox blocks dynamic import of node:os", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute(
      {
        code: `
          try {
            const m = await import("node:os");
            console.log("ESCAPED: " + m.hostname());
          } catch(e) {
            console.log("BLOCKED: " + e.message);
          }
        `,
      },
      ctx,
    );
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/BLOCKED/);
    expect(result as string).not.toMatch(/ESCAPED/);
  });

  test("run_code sandbox blocks fetch to cloud metadata endpoint", async () => {
    const defs = getBuiltinToolDefs(["run_code"]);
    const ctx = createMockToolContext();
    const result = await defs.run_code?.execute(
      {
        code: `
          try {
            const res = await fetch("http://169.254.169.254/latest/meta-data/");
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

  test("fetch_json delegates fetch without SSRF checks — platform adapter handles it", async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    const defs = getBuiltinToolDefs(["fetch_json"], {
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

  test("visit_webpage follows redirects without re-validating target", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === "https://evil.com/redirect") {
        return new Response("<html><body>metadata: leaked-iam-creds</body></html>", {
          status: 200,
        });
      }
      return new Response("", { status: 404 });
    });
    const defs = getBuiltinToolDefs(["visit_webpage"], {
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });
    const ctx = createMockToolContext();
    const result = await defs.visit_webpage?.execute({ url: "https://evil.com/redirect" }, ctx);
    expect(result).toHaveProperty("content");
    expect((result as { content: string }).content).toContain("leaked-iam-creds");
  });
});

describe("executeInIsolate", () => {
  test("arithmetic and output", async () => {
    const result = await executeInIsolate("console.log(2 + 2)");
    expect(result).toBe("4");
  });

  test("async code works", async () => {
    const result = await executeInIsolate(`
      const delay = (ms) => new Promise(r => setTimeout(r, ms));
      await delay(50);
      console.log("async done");
    `);
    expect(result).toBe("async done");
  });

  test("runtime errors return error object", async () => {
    const result = await executeInIsolate("throw new Error('boom')");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("boom");
  });

  test("http module not available via require", async () => {
    const result = await executeInIsolate(`
      try {
        const http = require("http");
        console.log("ESCAPED");
      } catch(e) {
        console.log("BLOCKED:" + e.message);
      }
    `);
    expect(result as string).toMatch(/BLOCKED/);
  });

  test("filesystem modules not available via require", async () => {
    const result = await executeInIsolate(`
      try {
        const fs = require("fs");
        fs.writeFileSync("/tmp/pwned.txt", "owned");
        console.log("ESCAPED");
      } catch(e) {
        console.log("BLOCKED:" + e.message);
      }
    `);
    expect(result as string).toMatch(/BLOCKED/);
  });

  test("child process modules not available via require", async () => {
    const result = await executeInIsolate(`
      try {
        const cp = require("child_process");
        cp.execSync("id");
        console.log("ESCAPED");
      } catch(e) {
        console.log("BLOCKED:" + e.message);
      }
    `);
    expect(result as string).toMatch(/BLOCKED/);
  });

  test("process.exit is not available", async () => {
    const result = await executeInIsolate(`
      try {
        process.exit(1);
        console.log("STILL_RUNNING");
      } catch(e) {
        console.log("BLOCKED:" + e.message);
      }
    `);
    expect(result as string).toMatch(/BLOCKED/);
  });

  test("global state does not persist between invocations", async () => {
    await executeInIsolate("globalThis.__secret = 'leaked';");
    const result = await executeInIsolate(`
      console.log(typeof globalThis.__secret === "undefined" ? "ISOLATED" : "LEAKED:" + globalThis.__secret);
    `);
    expect(result).toBe("ISOLATED");
  });

  test("variables do not leak between invocations", async () => {
    await executeInIsolate("var crossLeak = 42;");
    const result = await executeInIsolate(`
      try {
        console.log(typeof crossLeak === "undefined" ? "ISOLATED" : "LEAKED:" + crossLeak);
      } catch(e) {
        console.log("ISOLATED");
      }
    `);
    expect(result).toBe("ISOLATED");
  });
});
