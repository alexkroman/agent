// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { runDeploy } from "./_deploy.ts";
import { makeBundle } from "./_test-utils.ts";

function deployOk(): Response {
  return new Response(JSON.stringify({ ok: true }), {
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
    expect(String(url)).toBe("http://localhost:3000/cool-cats-jump/deploy");
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

  test("generates new slug on 403", async () => {
    let attempt = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt <= 2) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Slug "some-slug" is owned by another' }), {
            status: 403,
          }),
        );
      }
      return Promise.resolve(deployOk());
    });
    const result = await runDeploy(deployOpts(mockFetch));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/cool-cats-jump/");
    expect(typeof result.slug).toBe("string");
  });

  test("throws on non-403 error response", async () => {
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

  test("exhausts retries on repeated 403 slug conflicts", async () => {
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Slug "x" is owned by another' }), {
          status: 403,
        }),
      ),
    );
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow(
      "Could not find an available slug after 20 attempts",
    );
    expect(mockFetch).toHaveBeenCalledTimes(20);
  });

  test("403 without slug message throws immediately", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("deploy failed (HTTP 403)");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
