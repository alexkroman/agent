// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { runDeploy } from "./deploy.ts";
import { makeBundle } from "./test-utils.ts";

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

describe("_deploy", () => {
  describe("authentication failure handling", () => {
    test("401 includes API key hint", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
      await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("Your API key may be invalid");
    });

    test("401 includes status code and response body", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
      await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow(
        "deploy failed (HTTP 401): unauthorized",
      );
    });
  });

  describe("payload too large handling", () => {
    test("413 includes bundle size hint", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response("payload too large", { status: 413 }));
      await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("Your bundle is too large");
    });

    test("413 includes status code and response body", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response("payload too large", { status: 413 }));
      await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow(
        "deploy failed (HTTP 413): payload too large",
      );
    });
  });

  describe("network error handling", () => {
    test("network error includes network hint", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow(
        "Check your network connection",
      );
    });

    test("network error on remote URL includes network hint", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(
        runDeploy(deployOpts(mockFetch, { url: "https://api.example.com" })),
      ).rejects.toThrow("Check your network connection and verify the server URL is correct");
    });

    test("network error includes the target URL", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
      await expect(
        runDeploy(deployOpts(mockFetch, { url: "https://api.example.com" })),
      ).rejects.toThrow("could not reach https://api.example.com");
    });

    test("network error preserves original cause", async () => {
      const cause = new Error("ECONNREFUSED");
      const mockFetch = vi.fn().mockRejectedValue(cause);
      try {
        await runDeploy(deployOpts(mockFetch));
        expect.unreachable("should have thrown");
      } catch (err: unknown) {
        expect((err as Error).cause).toBe(cause);
      }
    });
  });

  describe("malformed response handling", () => {
    test("non-JSON success response still returns slug", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
      const result = await runDeploy(deployOpts(mockFetch));
      expect(result.slug).toBe("cool-cats-jump");
    });

    test("empty body error response includes status code", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 502 }));
      await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow("deploy failed (HTTP 502)");
    });

    test("error response with unexpected status includes body text", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("gateway timeout", { status: 504 }));
      await expect(runDeploy(deployOpts(mockFetch))).rejects.toThrow(
        "deploy failed (HTTP 504): gateway timeout",
      );
    });
  });

  describe("defaults", () => {
    test("uses provided slug on successful first attempt", async () => {
      const mockFetch = vi.fn().mockResolvedValue(deployOk());
      const result = await runDeploy(deployOpts(mockFetch, { slug: "my-agent" }));
      expect(result.slug).toBe("my-agent");
      expect(String(mockFetch.mock.calls[0]?.[0])).toContain("/my-agent/deploy");
    });
  });
});
