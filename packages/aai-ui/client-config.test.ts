// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, it, vi } from "vitest";
import { buildAgentUrl, fetchClientConfig } from "./client-config.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildAgentUrl", () => {
  it("resolves against a base without a trailing slash", () => {
    expect(buildAgentUrl("http://localhost:3000", "client-config").href).toBe(
      "http://localhost:3000/client-config",
    );
  });

  it("resolves against a slug base with a trailing slash", () => {
    expect(buildAgentUrl("https://host.example/my-agent/", "client-config").href).toBe(
      "https://host.example/my-agent/client-config",
    );
  });
});

describe("fetchClientConfig", () => {
  it("returns the parsed config", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ name: "a", greeting: "hi" }));
    await expect(fetchClientConfig("http://h/a/", fetchFn)).resolves.toEqual({
      name: "a",
      greeting: "hi",
    });
    expect(fetchFn).toHaveBeenCalledWith("http://h/a/client-config");
  });

  it("ignores unknown fields from an older server", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ kind: "agent", name: "a" }));
    await expect(fetchClientConfig("http://h/", fetchFn)).resolves.toEqual({ name: "a" });
  });

  it("degrades to the empty default on a 404 (older server without the endpoint)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "Not found" }, 404));
    await expect(fetchClientConfig("http://h/", fetchFn)).resolves.toEqual({});
  });

  it("degrades to the empty default on a malformed body", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ name: 42 }));
    await expect(fetchClientConfig("http://h/", fetchFn)).resolves.toEqual({});
  });

  it("degrades to the empty default on a network error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(fetchClientConfig("http://h/", fetchFn)).resolves.toEqual({});
  });

  it("degrades to the empty default on non-JSON output", async () => {
    const fetchFn = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    await expect(fetchClientConfig("http://h/", fetchFn)).resolves.toEqual({});
  });
});
