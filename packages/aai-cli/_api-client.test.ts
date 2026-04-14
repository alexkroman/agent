// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { apiError, apiRequest, apiRequestOrThrow, HINT_INVALID_API_KEY } from "./_api-client.ts";

/** Helper to create a mock fetch that returns a Response. */
function mockFetch(response: Partial<Response> & { ok: boolean; status: number }) {
  const body = response.body ?? null;
  const textValue =
    typeof (response as Record<string, unknown>)._text === "string"
      ? (response as Record<string, unknown>)._text
      : "";
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    headers: new Headers(),
    body,
    text: () => Promise.resolve(textValue as string),
    json: () => Promise.resolve({}),
    redirected: false,
    statusText: response.ok ? "OK" : "Error",
    type: "basic" as ResponseType,
    url: "",
    clone: () => ({}) as Response,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response);
}

describe("apiRequest", () => {
  test("adds Authorization header with Bearer token", async () => {
    const fetch = mockFetch({ ok: true, status: 200 });
    await apiRequest(
      "https://api.example.com/deploy",
      { apiKey: "my-key", action: "Deploy" },
      fetch,
    );

    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer my-key");
  });

  test("adds Content-Type header when body is present", async () => {
    const fetch = mockFetch({ ok: true, status: 200 });
    await apiRequest(
      "https://api.example.com/deploy",
      { apiKey: "my-key", action: "Deploy", body: JSON.stringify({ name: "test" }) },
      fetch,
    );

    const [, init] = fetch.mock.calls[0];
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  test("does not add Content-Type header when body is absent", async () => {
    const fetch = mockFetch({ ok: true, status: 200 });
    await apiRequest(
      "https://api.example.com/deploy",
      { apiKey: "my-key", action: "Deploy", method: "GET" },
      fetch,
    );

    const [, init] = fetch.mock.calls[0];
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  test("returns response on success without throwing", async () => {
    const fetch = mockFetch({ ok: true, status: 200 });
    const resp = await apiRequest(
      "https://api.example.com/deploy",
      { apiKey: "my-key", action: "Deploy" },
      fetch,
    );

    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(200);
  });

  test("returns response on non-ok status without throwing", async () => {
    const fetch = mockFetch({ ok: false, status: 500 });
    const resp = await apiRequest(
      "https://api.example.com/deploy",
      { apiKey: "my-key", action: "Deploy" },
      fetch,
    );

    expect(resp.ok).toBe(false);
    expect(resp.status).toBe(500);
  });

  test("throws descriptive error on network failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      apiRequest("https://api.example.com/deploy", { apiKey: "my-key", action: "Deploy" }, fetch),
    ).rejects.toThrow("Deploy failed: could not reach https://api.example.com/deploy");
  });

  test("network error includes hint about network connection", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      apiRequest("https://api.example.com/deploy", { apiKey: "my-key", action: "Deploy" }, fetch),
    ).rejects.toThrow("Check your network connection");
  });

  test("network error preserves original error as cause", async () => {
    const cause = new Error("ECONNREFUSED");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(cause);

    try {
      await apiRequest(
        "https://api.example.com/deploy",
        { apiKey: "my-key", action: "Deploy" },
        fetch,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).cause).toBe(cause);
    }
  });

  test("passes through additional RequestInit properties", async () => {
    const fetch = mockFetch({ ok: true, status: 200 });
    await apiRequest(
      "https://api.example.com/deploy",
      { apiKey: "my-key", action: "Deploy", method: "DELETE" },
      fetch,
    );

    const [, init] = fetch.mock.calls[0];
    expect(init?.method).toBe("DELETE");
  });

  test("does not pass apiKey or action to fetch", async () => {
    const fetch = mockFetch({ ok: true, status: 200 });
    await apiRequest(
      "https://api.example.com/deploy",
      { apiKey: "my-key", action: "Deploy" },
      fetch,
    );

    const [, init] = fetch.mock.calls[0];
    expect(init).not.toHaveProperty("apiKey");
    expect(init).not.toHaveProperty("action");
  });
});

describe("apiError", () => {
  test("formats error with action and status", () => {
    const err = apiError("Deploy", 500, "Internal Server Error");
    expect(err.message).toBe("Deploy failed (HTTP 500): Internal Server Error");
  });

  test("includes hint when provided", () => {
    const err = apiError("Deploy", 401, "Unauthorized", "Check your API key");
    expect(err.message).toBe("Deploy failed (HTTP 401): Unauthorized\n  Check your API key");
  });

  test("omits hint when not provided", () => {
    const err = apiError("Delete", 404, "Not Found");
    expect(err.message).not.toContain("\n");
  });

  test("returns an Error instance", () => {
    const err = apiError("Deploy", 500, "fail");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("apiRequestOrThrow", () => {
  test("returns response on 200", async () => {
    const fetch = mockFetch({ ok: true, status: 200 });
    const resp = await apiRequestOrThrow(
      "https://api.example.com/deploy",
      { apiKey: "my-key", action: "Deploy" },
      { fetch },
    );

    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(200);
  });

  test("throws on 401 with invalid API key hint", async () => {
    const fetch = mockFetch({ ok: false, status: 401, _text: "Unauthorized" } as Parameters<
      typeof mockFetch
    >[0]);

    await expect(
      apiRequestOrThrow(
        "https://api.example.com/deploy",
        { apiKey: "bad-key", action: "Deploy" },
        { fetch },
      ),
    ).rejects.toThrow(HINT_INVALID_API_KEY);
  });

  test("throws on 500 with response body in error message", async () => {
    const fetch = mockFetch({
      ok: false,
      status: 500,
      _text: "Internal Server Error",
    } as Parameters<typeof mockFetch>[0]);

    await expect(
      apiRequestOrThrow(
        "https://api.example.com/deploy",
        { apiKey: "my-key", action: "Deploy" },
        { fetch },
      ),
    ).rejects.toThrow("Deploy failed (HTTP 500): Internal Server Error");
  });

  test("uses custom hint for matching status code", async () => {
    const fetch = mockFetch({ ok: false, status: 409, _text: "Conflict" } as Parameters<
      typeof mockFetch
    >[0]);

    await expect(
      apiRequestOrThrow(
        "https://api.example.com/deploy",
        { apiKey: "my-key", action: "Deploy" },
        { fetch, hints: { 409: "Resource already exists" } },
      ),
    ).rejects.toThrow("Resource already exists");
  });

  test("does not include hint for unmatched status code", async () => {
    const fetch = mockFetch({ ok: false, status: 503, _text: "Service Unavailable" } as Parameters<
      typeof mockFetch
    >[0]);

    const err = await apiRequestOrThrow(
      "https://api.example.com/deploy",
      { apiKey: "my-key", action: "Deploy" },
      { fetch, hints: { 409: "Resource already exists" } },
    ).catch((e: Error) => e);

    expect(err.message).toBe("Deploy failed (HTTP 503): Service Unavailable");
    expect(err.message).not.toContain("\n");
  });
});

describe("HINT_INVALID_API_KEY", () => {
  test("is a string mentioning re-entering the API key", () => {
    expect(HINT_INVALID_API_KEY).toContain("API key");
    expect(HINT_INVALID_API_KEY).toContain("aai");
  });
});
