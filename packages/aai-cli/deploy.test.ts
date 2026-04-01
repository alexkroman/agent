// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { runDeploy } from "./_deploy.ts";
import { makeBundle } from "./_test-utils.ts";

function deployOk(slug = "cool-cats-jump"): Response {
  return new Response(JSON.stringify({ ok: true, slug }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const deployOpts = (fetch: typeof globalThis.fetch, overrides?: Record<string, unknown>) => ({
  url: "http://localhost:3000",
  bundle: makeBundle(),
  env: {},
  slug: "cool-cats-jump",
  apiKey: "test-key",
  fetch,
  ...overrides,
});

describe("runDeploy", () => {
  test("deploys bundle to server", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk());
    const result = await runDeploy(deployOpts(mockFetch));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://localhost:3000/deploy");
    expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer test-key");
    expect(result.slug).toBe("cool-cats-jump");
  });

  test("sends worker and clientFiles in body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk());
    await runDeploy(deployOpts(mockFetch));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string);
    expect(body.worker).toBe("// worker");
    expect(body.clientFiles).toEqual({ "index.html": "<html></html>" });
  });

  test("sends env vars in body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk());
    await runDeploy(deployOpts(mockFetch, { env: { MY_KEY: "secret" } }));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string);
    expect(body.env).toEqual({ MY_KEY: "secret" });
  });

  test("sends slug in body when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk("my-slug"));
    await runDeploy(deployOpts(mockFetch, { slug: "my-slug" }));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string);
    expect(body.slug).toBe("my-slug");
  });

  test("omits slug from body when not provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(deployOk("server-generated"));
    const result = await runDeploy(deployOpts(mockFetch, { slug: undefined }));
    const [, init] = mockFetch.mock.calls[0] ?? [];
    const body = JSON.parse(init?.body as string);
    expect(body.slug).toBeUndefined();
    expect(result.slug).toBe("server-generated");
  });

  test("throws on non-ok error response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("deploy failed (HTTP 500)");
  });

  test("throws on network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow(
      "could not reach http://localhost:3000",
    );
  });

  test("includes status code and body in error message", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("bad request: missing worker", { status: 400 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow(
      "deploy failed (HTTP 400): bad request: missing worker",
    );
  });

  test("401 throws with API key hint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("API key may be invalid");
  });

  test("413 throws with bundle size hint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("too large", { status: 413 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("bundle is too large");
  });
});
