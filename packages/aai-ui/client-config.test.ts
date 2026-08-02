// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, it, vi } from "vitest";
import { buildAgentUrl, fetchClientConfig, loadClientConfig } from "./client-config.ts";

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

describe("loadClientConfig", () => {
  // The session's broker decision hangs on this distinction. Collapsing a
  // FAILED lookup into `{}` made it indistinguishable from a server that
  // answered and named no sessionUrl, so one 503 (a sandbox that failed to
  // boot) latched the session onto the platform's `/:slug/websocket` — a
  // WebSocket redirect browsers can't follow — with no path back even once
  // the agent recovered.
  it("reports a successful lookup that named no sessionUrl", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ name: "a" }));
    await expect(loadClientConfig("http://h/", fetchFn)).resolves.toEqual({ name: "a" });
  });

  it("reports null when the server errors (sandbox still booting)", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "unavailable" }, 503));
    await expect(loadClientConfig("http://h/", fetchFn)).resolves.toBeNull();
  });

  it("reports null on a network error", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(loadClientConfig("http://h/", fetchFn)).resolves.toBeNull();
  });

  it("reports null on a malformed body", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ name: 42 }));
    await expect(loadClientConfig("http://h/", fetchFn)).resolves.toBeNull();
  });

  it("still reports a 404 as null — an older server is a failed lookup here", async () => {
    // fetchClientConfig degrades a 404 to {} so name/greeting keep working;
    // for the broker decision the caller falls back on its own latch instead.
    const fetchFn = vi.fn(async () => jsonResponse({ error: "Not found" }, 404));
    await expect(loadClientConfig("http://h/", fetchFn)).resolves.toBeNull();
  });
});
