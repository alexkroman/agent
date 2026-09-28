// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createMockToolContext, fakeFetch } from "./_test-utils.ts";
import { createBraveSearch } from "./brave-search.ts";

const braveBody = {
  web: {
    results: [
      {
        title: "The <strong>Moon</strong> &amp; tides",
        url: "https://example.com/moon",
        description: "How the <strong>Moon</strong> drives the tides &mdash; explained.",
        age: "2 days ago",
      },
      { title: "Second", url: "https://example.com/2" },
    ],
  },
};

const withKey = () => createMockToolContext({ env: { BRAVE_API_KEY: "brave-test-key" } });

function braveFetch(response: Response) {
  return vi.fn((_url: string, _init: RequestInit) => Promise.resolve(response));
}

describe("brave_search", () => {
  test("returns plain-text results and sends the key as a subscription token", async () => {
    const mockFetch = braveFetch(Response.json(braveBody));
    const result = await createBraveSearch(fakeFetch(mockFetch)).execute(
      { query: "moon tides" },
      withKey(),
    );
    expect(result).toEqual([
      {
        title: "The Moon & tides",
        url: "https://example.com/moon",
        description: "How the Moon drives the tides — explained.",
        age: "2 days ago",
      },
      { title: "Second", url: "https://example.com/2", description: "" },
    ]);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    const requested = new URL(String(url));
    expect(requested.host).toBe("api.search.brave.com");
    expect(requested.searchParams.get("q")).toBe("moon tides");
    expect(requested.searchParams.get("count")).toBe("5");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("brave-test-key");
    expect(headers.Accept).toBe("application/json");
  });

  test("freshness maps to Brave's window codes and max_results is clamped", async () => {
    const mockFetch = braveFetch(Response.json(braveBody));
    await createBraveSearch(fakeFetch(mockFetch)).execute(
      { query: "q", freshness: "week", max_results: 50 },
      withKey(),
    );
    const requested = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(requested.searchParams.get("freshness")).toBe("pw");
    expect(requested.searchParams.get("count")).toBe("10");
  });

  test("no key in the agent env is an error naming the variable, and nothing is fetched", async () => {
    const mockFetch = braveFetch(Response.json(braveBody));
    const result = await createBraveSearch(fakeFetch(mockFetch)).execute(
      { query: "q" },
      createMockToolContext({ env: { BRAVE_API_KEY: "  " } }),
    );
    expect(result).toMatchObject({ error: expect.stringContaining("Missing BRAVE_API_KEY") });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("a rejected key is named as the fix", async () => {
    const mockFetch = braveFetch(new Response("", { status: 401, statusText: "Unauthorized" }));
    const result = await createBraveSearch(fakeFetch(mockFetch)).execute({ query: "q" }, withKey());
    expect(result).toEqual({
      error:
        "Brave Search rejected BRAVE_API_KEY (401 Unauthorized) — check the key is valid and has a Search plan",
    });
  });

  test("a rate limit says to retry", async () => {
    const mockFetch = braveFetch(
      new Response("", { status: 429, statusText: "Too Many Requests" }),
    );
    const result = await createBraveSearch(fakeFetch(mockFetch)).execute({ query: "q" }, withKey());
    expect(result).toMatchObject({ error: expect.stringContaining("rate limit") });
  });

  test("a response with no web section is zero results, not an error", async () => {
    const mockFetch = braveFetch(Response.json({ type: "search" }));
    const result = await createBraveSearch(fakeFetch(mockFetch)).execute({ query: "q" }, withKey());
    expect(result).toEqual([]);
  });
});
