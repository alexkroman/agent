// Copyright 2025 the AAI authors. MIT license.
/**
 * Orchestrator security tests: slug validation / path traversal,
 * security headers and CORS, and WebSocket URL
 * validation. Cross-agent tenant-isolation tests live in
 * orchestrator-security.test.ts.
 */
import { MAX_SLUG_LENGTH } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { createOrchestrator } from "./orchestrator.ts";
import { SLUG_WS_RE, wsSlugFromPath } from "./orchestrator-ws.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { createTestOrchestrator, createTestStore, deploy, deployAgent } from "./test-utils.ts";

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

    const res = await deploy(fetch, { body: { slug } });
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

    // Untrusted origin is rejected. `toBeNull`, never
    // `not.toBe("https://evil.example.com")` — a regression to a blanket `*`
    // satisfies the negative form, on a surface serving every tenant's agent
    // page.
    const untrusted = await app.fetch(
      new Request("http://localhost/health", {
        headers: { Origin: "https://evil.example.com" },
      }),
    );
    expect(untrusted.headers.get("Access-Control-Allow-Origin")).toBeNull();
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
    // No allowedOrigins configured means reject cross-origin requests — and a
    // blanket `*` is a rejection of nothing, so the assertion is `toBeNull`.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

// ── WebSocket URL Validation ───────────────────────────────────────────

describe("websocket URL validation", () => {
  // Upgrades bypass Hono routing, so `createWsUpgrades` matches the path
  // itself. This binds to the PRODUCTION regex (`SLUG_WS_RE`, orchestrator-ws.ts)
  // rather than recomposing the pattern: a recomposed copy had no length bound
  // (`[a-z0-9_-]*` against production's `{0,62}`), so it accepted a 200-char
  // slug the upgrade path rejects — and even after that was fixed by composing
  // from `SLUG_PATTERN_SOURCE`, deleting the production regex outright would
  // not have failed this file.
  const wsPathRegex = SLUG_WS_RE;

  test.each([
    ["a plain slug", "/my-agent/websocket"],
    ["digits", "/agent123/websocket"],
    ["an underscore", "/my_agent/websocket"],
    ["the longest slug the grammar allows", `/${"a".repeat(MAX_SLUG_LENGTH)}/websocket`],
  ])("accepts %s", (_why, path) => {
    expect(wsPathRegex.test(path)).toBe(true);
  });

  test.each([
    ["path traversal", "/../etc/passwd/websocket"],
    ["a traversal segment after a valid slug", "/my-agent/../other/websocket"],
    ["uppercase", "/MyAgent/websocket"],
    ["dots", "/my.agent/websocket"],
    ["no slug", "//websocket"],
    ["extra path segments", "/agent/extra/websocket"],
    // The bound the hand-written copy dropped.
    ["a slug one character over the limit", `/${"a".repeat(MAX_SLUG_LENGTH + 1)}/websocket`],
    ["a wildly over-long slug", `/${"a".repeat(200)}/websocket`],
  ])("rejects %s", (_why, path) => {
    expect(wsPathRegex.test(path)).toBe(false);
  });

  test("the slug it captures is the one the upgrade handler brokers", () => {
    // `wsSlugFromPath` is the function the upgrade handler itself calls.
    expect(wsSlugFromPath("/my-agent/websocket")).toBe("my-agent");
    expect(wsSlugFromPath("/../etc/passwd/websocket")).toBeUndefined();
  });
});
