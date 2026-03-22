// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, test, vi } from "vitest";
import { _internals, runDeploy } from "./_deploy.ts";
import { makeBundle } from "./_test_utils.ts";

function deployOk(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const deployOpts = (overrides?: Record<string, unknown>) => ({
  url: "http://localhost:3000",
  bundle: makeBundle(),
  env: {},
  slug: "cool-cats-jump",
  apiKey: "test-key",
  ...overrides,
});

let fetchSpy: ReturnType<typeof vi.spyOn>;

afterEach(() => {
  fetchSpy?.mockRestore();
});

describe("runDeploy", () => {
  test("deploys bundle to server", async () => {
    fetchSpy = vi.spyOn(_internals, "fetch").mockResolvedValue(deployOk());
    const result = await runDeploy(deployOpts());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] ?? [];
    expect(String(call[0])).toBe("http://localhost:3000/cool-cats-jump/deploy");
    expect((call[1]?.headers as Record<string, string>)?.Authorization).toBe("Bearer test-key");
    expect(result.slug).toBe("cool-cats-jump");
  });

  test("generates new slug on 403", async () => {
    let attempt = 0;
    fetchSpy = vi.spyOn(_internals, "fetch").mockImplementation(() => {
      attempt++;
      if (attempt <= 2) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Slug "some-slug" is owned by another' }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(deployOk());
    });
    const result = await runDeploy(deployOpts());
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/cool-cats-jump/");
    expect(typeof result.slug).toBe("string");
  });

  test("throws on non-403 error response", async () => {
    fetchSpy = vi
      .spyOn(_internals, "fetch")
      .mockResolvedValue(new Response("server error", { status: 500 }));
    await expect(runDeploy(deployOpts())).rejects.toThrow("deploy failed (500)");
  });
});
