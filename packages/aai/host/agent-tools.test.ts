// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { fetchJson, visitWebpage, webSearch } from "./agent-tools.ts";

/**
 * These are thin wrappers over the same factories the model-facing builtins
 * use. What is worth pinning is that they REACH those factories — i.e. that a
 * tool author gets the screening, header stripping and size caps rather than
 * a bare `fetch` — so the tests drive real behaviour through an injected
 * network rather than asserting on the wrapper's shape.
 */
describe("callable builtins", () => {
  test("fetchJson parses a JSON body", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ price: 42 }), { status: 200 }));
    expect(await fetchJson("https://api.example.com/quote", { fetch })).toEqual({ price: 42 });
  });

  test("fetchJson reports an HTTP failure instead of throwing", async () => {
    // Matches the model-facing builtin: a tool handing this straight back to
    // the model should say something useful, not fail the turn.
    const fetch = vi.fn(
      async () => new Response("nope", { status: 503, statusText: "Unavailable" }),
    );
    const result = (await fetchJson("https://api.example.com/quote", { fetch })) as {
      error?: string;
    };
    expect(result.error).toContain("503");
  });

  test("fetchJson strips credential headers the caller passed", async () => {
    // The same sanitizer the builtin uses. A tool author forwarding request
    // headers wholesale must not leak an Authorization to a third-party host.
    const fetch = vi.fn(
      async (_url: unknown, _init?: unknown) => new Response("{}", { status: 200 }),
    );
    await fetchJson("https://api.example.com/x", {
      fetch,
      headers: { Authorization: "Bearer secret", Accept: "application/json" },
    });
    const init = fetch.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.Accept).toBe("application/json");
    expect(init?.headers?.Authorization).toBeUndefined();
  });

  test("visitWebpage and webSearch are callable", async () => {
    const fetch = vi.fn(
      async () => new Response("<html><body>hello</body></html>", { status: 200 }),
    );
    await expect(visitWebpage("https://example.com", { fetch })).resolves.toBeDefined();
    await expect(webSearch("anything", { maxResults: 1, fetch })).resolves.toBeDefined();
  });
});
