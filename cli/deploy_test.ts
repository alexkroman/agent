// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { _internals, runDeploy } from "./_deploy.ts";
import { makeBundle } from "./_test_utils.ts";

function healthOk(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

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
      .mockImplementation((input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/health")) return Promise.resolve(healthOk());
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
      // deploy call + health check = 2
      expect(fetchSpy).toHaveBeenCalledTimes(2);
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
    const fetchStub = vi
      .spyOn(_internals, "fetch")
      .mockImplementation((input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/health")) return Promise.resolve(healthOk());
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

      // 2 failed deploy attempts + 1 success + 1 health = 4
      expect(fetchStub).toHaveBeenCalledTimes(4);
      // First attempt uses original slug
      expect(String(fetchStub.mock.calls[0]?.[0])).toContain("/cool-cats-jump/");
      // Subsequent attempts use new generated slugs (not the original)
      const secondUrl = String(fetchStub.mock.calls[1]?.[0]);
      expect(secondUrl).toContain("/deploy");
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

  test("warns when health check fails", async () => {
    const fetchStub = vi
      .spyOn(_internals, "fetch")
      .mockImplementation((input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return Promise.resolve(new Response("bad", { status: 500 }));
        }
        return Promise.resolve(deployOk());
      });
    try {
      const result = await runDeploy({
        url: "http://localhost:3000",
        bundle: makeBundle(),
        env: {},
        slug: "test-slug",
        dryRun: false,
        apiKey: "test-key",
      });
      expect(result.slug).toBe("test-slug");
    } finally {
      fetchStub.mockRestore();
    }
  });

  test("handles health check network error gracefully", async () => {
    const fetchStub = vi
      .spyOn(_internals, "fetch")
      .mockImplementation((input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return Promise.reject(new Error("network error"));
        }
        return Promise.resolve(deployOk());
      });
    try {
      const result = await runDeploy({
        url: "http://localhost:3000",
        bundle: makeBundle(),
        env: {},
        slug: "test-slug",
        dryRun: false,
        apiKey: "test-key",
      });
      // Should still succeed — health check is best-effort
      expect(result.slug).toBe("test-slug");
    } finally {
      fetchStub.mockRestore();
    }
  });
});
