// Copyright 2025 the AAI authors. MIT license.
/**
 * Orchestrator security tests: slug validation / path traversal,
 * security headers and CORS, and WebSocket URL
 * validation. Cross-agent tenant-isolation tests live in
 * orchestrator-security.test.ts.
 */
import { describe, expect, test } from "vitest";
import { createOrchestrator } from "./orchestrator.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import {
  authHeaders,
  createTestOrchestrator,
  createTestStore,
  deployAgent,
  deployBody,
} from "./test-utils.ts";

// ── Slug Validation & Path Traversal ───────────────────────────────────

describe("slug validation prevents path traversal", () => {
  // The slug travels in the deploy body; DeployBodySchema must reject
  // anything outside the slug grammar before it becomes a storage path.
  test.each([
    ["path traversal characters", "../etc/passwd"],
    ["URL-encoded traversal", "%2e%2e%2fetc%2fpasswd"],
    ["a reserved name", "studio"],
  ])("deploy rejects a body slug with %s", async (_why, slug) => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch("/deploy", {
      method: "POST",
      headers: authHeaders(),
      body: deployBody({ slug }),
    });
    expect(res.status).toBe(400);
  });

  // Same assertion for every malformed slug in a request PATH, so the grammar
  // is a table rather than six copy-pasted bodies — a new rule is one row.
  test.each([
    ["dots", "/my.agent/health"],
    ["uppercase letters", "/MyAgent/health"],
    ["spaces", "/my agent/health"],
    ["a leading hyphen", "/-agent/health"],
    ["a trailing hyphen", "/agent-/health"],
    ["over 64 characters", `/${"a".repeat(65)}/health`],
  ])("rejects a slug with %s", async (_why, path) => {
    const { fetch } = await createTestOrchestrator();

    const res = await fetch(path);
    expect(res.status).toBe(400);
  });
});

// ── Security Headers ───────────────────────────────────────────────────

describe("security headers on all response types", () => {
  test("health endpoint includes security headers", async () => {
    const store = createTestStore();
    const { app } = createOrchestrator({
      slots: createSlotCache(),
      store,
    });
    const res = await app.fetch(new Request("http://localhost/health"));

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // SAMEORIGIN (not DENY): the studio previews agent pages in a same-origin
    // iframe; cross-origin framing (clickjacking) stays blocked.
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  test("404 responses include security headers", async () => {
    const store = createTestStore();
    const { app } = createOrchestrator({
      slots: createSlotCache(),
      store,
    });
    const res = await app.fetch(new Request("http://localhost/nonexistent"));

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  test("error responses include security headers", async () => {
    const { fetch } = await createTestOrchestrator();

    // Trigger a 401
    const res = await fetch("/deploy", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("agent-scoped responses include security headers", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent", "key1");

    const res = await fetch("/my-agent/health");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // SAMEORIGIN (not DENY): the studio previews agent pages in a same-origin
    // iframe; cross-origin framing (clickjacking) stays blocked.
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  test("CORS headers restrict allowed origins when configured", async () => {
    const store = createTestStore();
    const { app } = createOrchestrator({
      slots: createSlotCache(),
      store,
      allowedOrigins: ["https://trusted.example.com"],
    });

    // Trusted origin gets reflected
    const trusted = await app.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://trusted.example.com" },
      }),
    );
    expect(trusted.headers.get("Access-Control-Allow-Origin")).toBe("https://trusted.example.com");

    // Untrusted origin is rejected
    const untrusted = await app.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://evil.example.com" },
      }),
    );
    expect(untrusted.headers.get("Access-Control-Allow-Origin")).not.toBe(
      "https://evil.example.com",
    );
  });

  test("CORS rejects cross-origin when no origins configured", async () => {
    const store = createTestStore();
    const { app } = createOrchestrator({
      slots: createSlotCache(),
      store,
    });

    const res = await app.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://any-site.com" },
      }),
    );
    // No allowedOrigins configured means reject cross-origin requests
    const acao = res.headers.get("Access-Control-Allow-Origin");
    expect(acao).not.toBe("https://any-site.com");
  });
});

// ── WebSocket URL Validation ───────────────────────────────────────────

describe("websocket URL validation", () => {
  test("WebSocket path regex rejects invalid slugs", () => {
    const wsPathRegex = /^\/[a-z0-9][a-z0-9_-]*[a-z0-9]\/websocket$/;

    // Valid
    expect(wsPathRegex.test("/my-agent/websocket")).toBe(true);
    expect(wsPathRegex.test("/agent123/websocket")).toBe(true);
    expect(wsPathRegex.test("/my_agent/websocket")).toBe(true);

    // Invalid — path traversal
    expect(wsPathRegex.test("/../etc/passwd/websocket")).toBe(false);
    expect(wsPathRegex.test("/my-agent/../other/websocket")).toBe(false);

    // Invalid — uppercase
    expect(wsPathRegex.test("/MyAgent/websocket")).toBe(false);

    // Invalid — dots
    expect(wsPathRegex.test("/my.agent/websocket")).toBe(false);

    // Invalid — no slug
    expect(wsPathRegex.test("//websocket")).toBe(false);

    // Invalid — extra path segments
    expect(wsPathRegex.test("/agent/extra/websocket")).toBe(false);
  });
});
