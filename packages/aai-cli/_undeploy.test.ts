// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { runUndeploy } from "./_undeploy.ts";

const undeployOpts = (fetch: typeof globalThis.fetch, overrides?: Record<string, unknown>) => ({
  url: "http://localhost:3000",
  slug: "cool-cats-jump",
  apiKey: "test-key",
  fetch,
  ...overrides,
});

describe("_undeploy", () => {
  describe("successful undeploy", () => {
    test("resolves on 200 response", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await expect(runUndeploy(undeployOpts(mockFetch))).resolves.toBeUndefined();
    });

    test("sends POST to correct URL with auth header", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
      await runUndeploy(undeployOpts(mockFetch));
      expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/cool-cats-jump/undeploy", {
        method: "POST",
        headers: { Authorization: "Bearer test-key" },
      });
    });
  });

  describe("authentication failure handling", () => {
    test("401 includes API key hint", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
      await expect(runUndeploy(undeployOpts(mockFetch))).rejects.toThrow(
        "Your API key may be invalid",
      );
    });

    test("401 includes status code and response body", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
      await expect(runUndeploy(undeployOpts(mockFetch))).rejects.toThrow(
        "undeploy failed (HTTP 401): unauthorized",
      );
    });
  });

  describe("not found handling", () => {
    test("404 includes deployment hint", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
      await expect(runUndeploy(undeployOpts(mockFetch))).rejects.toThrow(
        "The agent may not be deployed",
      );
    });
  });

  describe("network error handling", () => {
    test("network error on localhost includes dev server hint", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(runUndeploy(undeployOpts(mockFetch))).rejects.toThrow(
        "Is the local dev server running?",
      );
    });

    test("network error on remote URL includes network hint", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(
        runUndeploy(undeployOpts(mockFetch, { url: "https://api.example.com" })),
      ).rejects.toThrow("Check your network connection and verify the server URL is correct");
    });

    test("network error includes the target URL", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
      await expect(
        runUndeploy(undeployOpts(mockFetch, { url: "https://api.example.com" })),
      ).rejects.toThrow("could not reach https://api.example.com");
    });

    test("network error preserves original cause", async () => {
      const cause = new Error("ECONNREFUSED");
      const mockFetch = vi.fn().mockRejectedValue(cause);
      try {
        await runUndeploy(undeployOpts(mockFetch));
        expect.unreachable("should have thrown");
      } catch (err: unknown) {
        expect((err as Error).cause).toBe(cause);
      }
    });
  });

  describe("error response handling", () => {
    test("empty body error response includes status code", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 502 }));
      await expect(runUndeploy(undeployOpts(mockFetch))).rejects.toThrow(
        "undeploy failed (HTTP 502)",
      );
    });

    test("error response with unexpected status includes body text", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("gateway timeout", { status: 504 }));
      await expect(runUndeploy(undeployOpts(mockFetch))).rejects.toThrow(
        "undeploy failed (HTTP 504): gateway timeout",
      );
    });
  });
});
