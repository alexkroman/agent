// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { apiRequest, HINT_INVALID_API_KEY } from "./_api-client.ts";

/** Mock fetch returning a JSON Response with the given status/body. */
function mockFetch(status: number, body: unknown = {}) {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/** Extract the Authorization-style headers from a recorded fetch call. */
function headersOf(fetch: ReturnType<typeof mockFetch>): Headers {
  const [, init] = fetch.mock.calls[0] ?? [];
  return new Headers(init?.headers);
}

describe("apiRequest", () => {
  test("adds Authorization header with Bearer token", async () => {
    const fetch = mockFetch(200);
    await apiRequest("https://api.example.com/deploy", {
      apiKey: "my-key",
      action: "deploy",
      fetch,
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(headersOf(fetch).get("authorization")).toBe("Bearer my-key");
  });

  test("serializes object body as JSON with Content-Type header", async () => {
    const fetch = mockFetch(200);
    await apiRequest("https://api.example.com/deploy", {
      apiKey: "my-key",
      action: "deploy",
      method: "POST",
      body: { name: "test" },
      fetch,
    });

    expect(headersOf(fetch).get("content-type")).toBe("application/json");
    const [, init] = fetch.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toEqual({ name: "test" });
  });

  test("does not add Content-Type header when body is absent", async () => {
    const fetch = mockFetch(200);
    await apiRequest("https://api.example.com/deploy", {
      apiKey: "my-key",
      action: "deploy",
      method: "GET",
      fetch,
    });

    expect(headersOf(fetch).get("content-type")).toBeNull();
  });

  test("returns parsed JSON on success", async () => {
    const fetch = mockFetch(200, { slug: "my-agent" });
    const data = await apiRequest<{ slug: string }>("https://api.example.com/deploy", {
      apiKey: "my-key",
      action: "deploy",
      fetch,
    });

    expect(data.slug).toBe("my-agent");
  });

  test("passes method through to fetch", async () => {
    const fetch = mockFetch(200);
    await apiRequest("https://api.example.com/deploy", {
      apiKey: "my-key",
      action: "delete",
      method: "DELETE",
      fetch,
    });

    const [, init] = fetch.mock.calls[0] ?? [];
    expect(init?.method).toBe("DELETE");
  });

  test("throws on 401 with invalid API key hint (no retry)", async () => {
    const fetch = mockFetch(401, { error: "Unauthorized" });

    await expect(
      apiRequest("https://api.example.com/deploy", {
        apiKey: "bad-key",
        action: "deploy",
        fetch,
      }),
    ).rejects.toThrow(HINT_INVALID_API_KEY);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("throws with action, status, and response body in error message", async () => {
    const fetch = mockFetch(404, "not found");

    await expect(
      apiRequest("https://api.example.com/deploy", {
        apiKey: "my-key",
        action: "deploy",
        fetch,
      }),
    ).rejects.toThrow("deploy failed (HTTP 404): not found");
  });

  test("uses custom hint for matching status code", async () => {
    const fetch = mockFetch(413, "too large");

    await expect(
      apiRequest("https://api.example.com/deploy", {
        apiKey: "my-key",
        action: "deploy",
        hints: { 413: "Your bundle is too large" },
        fetch,
      }),
    ).rejects.toThrow("Your bundle is too large");
  });

  test("does not include hint for unmatched status code", async () => {
    const fetch = mockFetch(404, "not found");

    await expect(
      apiRequest("https://api.example.com/deploy", {
        apiKey: "my-key",
        action: "deploy",
        hints: { 413: "Your bundle is too large" },
        fetch,
      }),
    ).rejects.toThrow("deploy failed (HTTP 404): not found");
  });

  test("retries transient 5xx failures before succeeding", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ slug: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const data = await apiRequest<{ slug: string }>("https://api.example.com/deploy", {
      apiKey: "my-key",
      action: "deploy",
      fetch,
    });

    expect(data.slug).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("throws descriptive error with hint on network failure", async () => {
    const cause = new Error("ECONNREFUSED");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(cause);

    const promise = apiRequest("https://api.example.com/deploy", {
      apiKey: "my-key",
      action: "deploy",
      fetch,
    });
    await expect(promise).rejects.toThrow(
      "deploy failed: could not reach https://api.example.com/deploy",
    );
    await expect(promise).rejects.toThrow("Check your network connection");
  });

  test("network error preserves original error as cause", async () => {
    const cause = new Error("ECONNREFUSED");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(cause);

    try {
      await apiRequest("https://api.example.com/deploy", {
        apiKey: "my-key",
        action: "deploy",
        fetch,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).cause).toBe(cause);
    }
  });
});

describe("HINT_INVALID_API_KEY", () => {
  test("is a string mentioning re-entering the API key", () => {
    expect(HINT_INVALID_API_KEY).toContain("API key");
    expect(HINT_INVALID_API_KEY).toContain("aai");
  });
});
