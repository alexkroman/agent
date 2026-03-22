// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { runDeploy } from "./_deploy.ts";
import { makeBundle } from "./_test_utils.ts";

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
    await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("deploy failed (500)");
  });
});
