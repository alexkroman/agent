// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { type DeployOpts, runDeploy } from "./_deploy.ts";
import { makeBundle } from "./_test-utils.ts";

/** Build a DeployOpts object with a mock fetch. */
function deployOpts(fetch: typeof globalThis.fetch, overrides?: Partial<DeployOpts>): DeployOpts {
  return {
    url: "http://localhost:3000",
    bundle: makeBundle(),
    env: {},
    slug: "test-agent",
    apiKey: "test-key",
    fetch,
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("runDeploy — additional coverage", () => {
  test("sends POST to /deploy endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ slug: "test-agent" }));
    await runDeploy(deployOpts(mockFetch));
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://localhost:3000/deploy");
    expect(init.method).toBe("POST");
  });

  test("sends Content-Type application/json header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ slug: "test-agent" }));
    await runDeploy(deployOpts(mockFetch));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  test("includes clientFiles from bundle in request body", async () => {
    const bundle = makeBundle({
      clientFiles: { "index.html": "<html></html>", "app.js": "console.log('hi')" },
    });
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ slug: "s" }));
    await runDeploy(deployOpts(mockFetch, { bundle }));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = JSON.parse(init.body as string);
    expect(body.clientFiles).toEqual({
      "index.html": "<html></html>",
      "app.js": "console.log('hi')",
    });
  });

  test("includes agentConfig from bundle in request body", async () => {
    const bundle = makeBundle({
      agentConfig: {
        name: "custom-agent",
        systemPrompt: "You are helpful",
        greeting: "Hello!",
        maxSteps: 10,
        toolChoice: "required",
        builtinTools: ["run_code"],
        toolSchemas: [{ name: "search", description: "Search", parameters: {} }],
      },
    });
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ slug: "s" }));
    await runDeploy(deployOpts(mockFetch, { bundle }));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = JSON.parse(init.body as string);
    expect(body.agentConfig.name).toBe("custom-agent");
    expect(body.agentConfig.greeting).toBe("Hello!");
    expect(body.agentConfig.maxSteps).toBe(10);
    expect(body.agentConfig.builtinTools).toEqual(["run_code"]);
  });

  test("returns slug from server response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ slug: "server-returned-slug" }));
    const result = await runDeploy(deployOpts(mockFetch));
    expect(result.slug).toBe("server-returned-slug");
  });

  test("handles 413 payload too large with bundle size hint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("payload too large", { status: 413 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("bundle is too large");
  });

  test("handles 401 unauthorized with API key hint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("API key may be invalid");
  });

  test("throws on 500 server error", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("internal server error", { status: 500 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("deploy failed (HTTP 500)");
  });

  test("includes multiple env vars in request body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ slug: "s" }));
    const env = { API_KEY: "sk-123", DB_URL: "postgres://localhost" };
    await runDeploy(deployOpts(mockFetch, { env }));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = JSON.parse(init.body as string);
    expect(body.env).toEqual({ API_KEY: "sk-123", DB_URL: "postgres://localhost" });
  });

  test("uses custom url in request", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ slug: "s" }));
    await runDeploy(deployOpts(mockFetch, { url: "https://prod.example.com" }));
    const [url] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://prod.example.com/deploy");
  });

  test("handles network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("could not reach");
  });
});
