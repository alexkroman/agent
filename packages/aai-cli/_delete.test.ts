// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { runDelete } from "./_delete.ts";

const deleteOpts = (fetch: typeof globalThis.fetch, overrides?: Record<string, unknown>) => ({
  url: "http://localhost:3000",
  slug: "cool-cats-jump",
  apiKey: "test-key",
  fetch,
  ...overrides,
});

describe("_delete", () => {
  describe("successful delete", () => {
    test("resolves on 200 response", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await expect(runDelete(deleteOpts(mockFetch))).resolves.toBeUndefined();
    });

    test("sends DELETE to correct URL with auth header", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
      await runDelete(deleteOpts(mockFetch));
      expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/cool-cats-jump", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-key" },
      });
    });
  });

  describe("authentication failure handling", () => {
    test("401 includes API key hint", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
      await expect(runDelete(deleteOpts(mockFetch))).rejects.toThrow("Your API key may be invalid");
    });

    test("401 includes status code and response body", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
      await expect(runDelete(deleteOpts(mockFetch))).rejects.toThrow(
        "delete failed (HTTP 401): unauthorized",
      );
    });
  });

  describe("not found handling", () => {
    test("404 includes deployment hint", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
      await expect(runDelete(deleteOpts(mockFetch))).rejects.toThrow(
        "The agent may not be deployed",
      );
    });
  });

  describe("network error handling", () => {
    test("network error includes network hint", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(runDelete(deleteOpts(mockFetch))).rejects.toThrow(
        "Check your network connection",
      );
    });

    test("network error on remote URL includes network hint", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(
        runDelete(deleteOpts(mockFetch, { url: "https://api.example.com" })),
      ).rejects.toThrow("Check your network connection and verify the server URL is correct");
    });

    test("network error includes the target URL", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
      await expect(
        runDelete(deleteOpts(mockFetch, { url: "https://api.example.com" })),
      ).rejects.toThrow("could not reach https://api.example.com");
    });

    test("network error preserves original cause", async () => {
      const cause = new Error("ECONNREFUSED");
      const mockFetch = vi.fn().mockRejectedValue(cause);
      try {
        await runDelete(deleteOpts(mockFetch));
        expect.unreachable("should have thrown");
      } catch (err: unknown) {
        expect((err as Error).cause).toBe(cause);
      }
    });
  });

  describe("error response handling", () => {
    test("empty body error response includes status code", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 502 }));
      await expect(runDelete(deleteOpts(mockFetch))).rejects.toThrow("delete failed (HTTP 502)");
    });

    test("error response with unexpected status includes body text", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("gateway timeout", { status: 504 }));
      await expect(runDelete(deleteOpts(mockFetch))).rejects.toThrow(
        "delete failed (HTTP 504): gateway timeout",
      );
    });
  });
});
