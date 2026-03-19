// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { _internals, runDeploy } from "./_deploy.ts";
import { makeBundle } from "./_test_utils.ts";

function deployOk(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("runDeploy", () => {
  test("deploys bundle to server", async () => {
    const fetchSpy = vi
      .spyOn(_internals, "fetch")
      .mockImplementation(() => Promise.resolve(deployOk()));
    try {
      const result = await runDeploy({
        url: "http://localhost:3000",
        bundle: makeBundle(),
        env: {},
        slug: "cool-cats-jump",
        dryRun: false,
        apiKey: "test-key",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const deployCall = fetchSpy.mock.calls[0] ?? [];
      expect(String(deployCall[0])).toBe("http://localhost:3000/cool-cats-jump/deploy");
      expect((deployCall[1]?.headers as Record<string, string>)?.Authorization).toBe(
        "Bearer test-key",
      );
      expect(result.slug).toBe("cool-cats-jump");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("generates new slug on 403", async () => {
    let attempt = 0;
    const fetchStub = vi.spyOn(_internals, "fetch").mockImplementation(() => {
      attempt++;
      if (attempt <= 2) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: 'Slug "some-slug" is owned by another',
            }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(deployOk());
    });
    try {
      const result = await runDeploy({
        url: "http://localhost:3000",
        bundle: makeBundle(),
        env: {},
        slug: "cool-cats-jump",
        dryRun: false,
        apiKey: "test-key",
      });

      // 2 failed deploy attempts + 1 success = 3
      expect(fetchStub).toHaveBeenCalledTimes(3);
      // First attempt uses original slug
      expect(String(fetchStub.mock.calls[0]?.[0])).toContain("/cool-cats-jump/");
      // Result slug should be whatever the last attempt used (a generated slug)
      expect(typeof result.slug).toBe("string");
    } finally {
      fetchStub.mockRestore();
    }
  });

  test("dry run does not call fetch", async () => {
    const fetchStub = vi
      .spyOn(_internals, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("ok")));
    try {
      const result = await runDeploy({
        url: "http://localhost:3000",
        bundle: makeBundle(),
        env: {},
        slug: "cool-cats-jump",
        dryRun: true,
        apiKey: "test-key",
      });
      expect(fetchStub).toHaveBeenCalledTimes(0);
      expect(result.slug).toBe("cool-cats-jump");
    } finally {
      fetchStub.mockRestore();
    }
  });

  test("throws on non-403 error response", async () => {
    const fetchStub = vi
      .spyOn(_internals, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("server error", { status: 500 })));
    try {
      await expect(
        runDeploy({
          url: "http://localhost:3000",
          bundle: makeBundle(),
          env: {},
          slug: "cool-cats-jump",
          dryRun: false,
          apiKey: "test-key",
        }),
      ).rejects.toThrow("deploy failed (500)");
    } finally {
      fetchStub.mockRestore();
    }
  });
});
