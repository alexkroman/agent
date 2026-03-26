// Copyright 2025 the AAI authors. MIT license.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildNetworkAdapter, buildNetworkPolicy } from "./sandbox-network.ts";

vi.mock("secure-exec", () => ({
  createDefaultNetworkAdapter: () => ({
    fetch: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      body: "default",
      url: "",
      redirected: false,
    }),
  }),
}));

// ── buildNetworkPolicy ──────────────────────────────────────────────────

describe("buildNetworkPolicy", () => {
  const SIDECAR = "http://127.0.0.1:9876";
  const policy = buildNetworkPolicy(SIDECAR);

  test("allows listen ops", () => {
    expect(policy({ op: "listen" })).toEqual({ allow: true });
  });

  test("allows loopback DNS (localhost)", () => {
    expect(policy({ op: "dns", hostname: "localhost" })).toEqual({ allow: true });
  });

  test("allows loopback DNS (127.0.0.1)", () => {
    expect(policy({ op: "dns", hostname: "127.0.0.1" })).toEqual({ allow: true });
  });

  test("allows loopback DNS (::1)", () => {
    expect(policy({ op: "dns", hostname: "::1" })).toEqual({ allow: true });
  });

  test("blocks external DNS", () => {
    const result = policy({ op: "dns", hostname: "evil.com" });
    expect(result.allow).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  test("blocks DNS with missing hostname", () => {
    const result = policy({ op: "dns" });
    expect(result.allow).toBe(false);
  });

  test("allows sidecar URL", () => {
    expect(policy({ op: "fetch", url: "http://127.0.0.1:9876/v1/tools" })).toEqual({ allow: true });
  });

  test("blocks external URL", () => {
    const result = policy({ op: "fetch", url: "https://evil.com/steal" });
    expect(result.allow).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  test("blocks loopback URL on wrong port", () => {
    const result = policy({ op: "fetch", url: "http://127.0.0.1:1111/path" });
    expect(result.allow).toBe(false);
  });

  test("blocks loopback URL on wrong host", () => {
    const result = policy({ op: "fetch", url: "http://localhost:9876/path" });
    expect(result.allow).toBe(false);
  });

  test("blocks cloud metadata URL", () => {
    const result = policy({ op: "fetch", url: "http://169.254.169.254/latest/meta-data" });
    expect(result.allow).toBe(false);
  });

  test("blocks request with no URL for non-listen/dns ops", () => {
    const result = policy({ op: "fetch" });
    expect(result.allow).toBe(false);
  });
});

// ── SidecarUrlSchema validation ─────────────────────────────────────────

describe("SidecarUrlSchema (via buildNetworkPolicy)", () => {
  test("rejects non-loopback sidecar URL", () => {
    expect(() => buildNetworkPolicy("http://10.0.0.1:9876")).toThrow();
  });

  test("rejects external hostname as sidecar", () => {
    expect(() => buildNetworkPolicy("http://evil.com:9876")).toThrow();
  });

  test("rejects invalid URL", () => {
    expect(() => buildNetworkPolicy("not-a-url")).toThrow();
  });

  test("accepts localhost sidecar", () => {
    const policy = buildNetworkPolicy("http://localhost:5555");
    expect(policy({ op: "listen" })).toEqual({ allow: true });
  });

  // Note: IPv6 [::1] URLs are rejected because URL.hostname returns "[::1]"
  // (with brackets) which does not match the "::1" entry in LOOPBACK_HOSTS.
  // In practice, sidecars always bind to 127.0.0.1 so this is acceptable.
  test("rejects ::1 sidecar URL (brackets mismatch)", () => {
    expect(() => buildNetworkPolicy("http://[::1]:5555")).toThrow();
  });
});

// ── buildNetworkAdapter ─────────────────────────────────────────────────

describe("buildNetworkAdapter", () => {
  const SIDECAR = "http://127.0.0.1:9876";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("routes sidecar calls through globalThis.fetch", async () => {
    const mockResponse = new Response('{"ok":true}', {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const adapter = buildNetworkAdapter(SIDECAR);
    const result = await adapter.fetch("http://127.0.0.1:9876/v1/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"tool":"test"}',
    });

    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:9876/v1/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"tool":"test"}',
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
    expect(result.headers["content-type"]).toBe("application/json");
  });

  test("delegates non-sidecar calls to default adapter", async () => {
    // globalThis.fetch should NOT be called for non-sidecar URLs
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));

    const adapter = buildNetworkAdapter(SIDECAR);
    const result = await adapter.fetch("https://example.com/api", { method: "GET" });

    // Should have gone through mock default adapter, not direct fetch
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.body).toBe("default");
  });

  test("sidecar fetch defaults method to GET", async () => {
    const mockResponse = new Response("ok");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const adapter = buildNetworkAdapter(SIDECAR);
    await adapter.fetch("http://127.0.0.1:9876/health", {});

    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:9876/health", {
      method: "GET",
    });
  });

  test("sidecar fetch omits headers when undefined", async () => {
    const mockResponse = new Response("ok");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(init).not.toHaveProperty("headers");
      return mockResponse;
    });

    const adapter = buildNetworkAdapter(SIDECAR);
    await adapter.fetch("http://127.0.0.1:9876/health", { method: "GET" });
  });

  test("does not bypass SSRF for different port on same host", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));

    const adapter = buildNetworkAdapter(SIDECAR);
    await adapter.fetch("http://127.0.0.1:6666/steal", { method: "GET" });

    // Should go through default adapter, not direct fetch bypass
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
