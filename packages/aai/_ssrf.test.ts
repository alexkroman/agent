// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { assertPublicUrl, isPrivateIp, ssrfSafeFetch } from "./_ssrf.ts";

// ─── isPrivateIp ─────────────────────────────────────────────────────────────

describe("isPrivateIp", () => {
  test.each([
    ["0.0.0.1", true],
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["100.64.0.1", true],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["169.254.1.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.0.0.1", true],
    ["192.168.0.1", true],
    ["192.168.255.255", true],
    ["198.18.0.1", true],
    ["224.0.0.1", true],
    ["240.0.0.1", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["93.184.216.34", false],
    ["::1", true],
    ["::", true],
    ["fc00::1", true],
    ["fe80::1", true],
    ["ff02::1", true],
  ])("isPrivateIp(%s) → %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });

  test("172.32.0.1 is NOT private (just outside 172.16/12)", () => {
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });
});

// ─── assertPublicUrl ─────────────────────────────────────────────────────────

describe("assertPublicUrl", () => {
  describe("blocks private IPv4 ranges", () => {
    test.each([
      "http://0.0.0.1/",
      "http://10.0.0.1/",
      "http://100.64.0.1/",
      "http://127.0.0.1/",
      "http://169.254.1.1/",
      "http://172.16.0.1/",
      "http://192.0.0.1/",
      "http://192.168.0.1/",
      "http://198.18.0.1/",
      "http://224.0.0.1/",
      "http://240.0.0.1/",
    ])("blocks %s", async (url) => {
      await expect(assertPublicUrl(url)).rejects.toThrow("Blocked request to private address");
    });
  });

  describe("IPv4-mapped IPv6 bypass prevention", () => {
    test("blocks ::ffff:127.0.0.1 (dotted form)", async () => {
      await expect(assertPublicUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(
        "Blocked request to private address",
      );
    });

    test("blocks ::ffff:7f00:1 (hex form)", async () => {
      await expect(assertPublicUrl("http://[::ffff:7f00:1]/")).rejects.toThrow(
        "Blocked request to private address",
      );
    });

    test("blocks ::ffff:a9fe:a9fe (169.254.169.254 in hex)", async () => {
      await expect(assertPublicUrl("http://[::ffff:a9fe:a9fe]/")).rejects.toThrow(
        "Blocked request to private address",
      );
    });
  });

  describe("blocks dangerous hostnames", () => {
    test("blocks localhost", async () => {
      await expect(assertPublicUrl("http://localhost/")).rejects.toThrow(
        "Blocked request to private address",
      );
    });

    test("blocks .local domains", async () => {
      await expect(assertPublicUrl("http://myhost.local/")).rejects.toThrow(
        "Blocked request to private address",
      );
    });

    test("blocks .internal domains", async () => {
      await expect(assertPublicUrl("http://service.internal/")).rejects.toThrow(
        "Blocked request to private address",
      );
    });

    test("blocks metadata.google.internal", async () => {
      await expect(assertPublicUrl("http://metadata.google.internal/")).rejects.toThrow(
        "Blocked request to private address",
      );
    });

    test("blocks cloud metadata IP 169.254.169.254", async () => {
      await expect(assertPublicUrl("http://169.254.169.254/")).rejects.toThrow(
        "Blocked request to private address",
      );
    });
  });

  describe("protocol restrictions", () => {
    test("blocks ftp:", async () => {
      await expect(assertPublicUrl("ftp://example.com/")).rejects.toThrow(
        "Blocked request with disallowed protocol",
      );
    });

    test("blocks file:", async () => {
      await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(
        "Blocked request with disallowed protocol",
      );
    });

    test("allows http:", async () => {
      await expect(assertPublicUrl("http://example.com/")).resolves.toBeUndefined();
    });

    test("allows https:", async () => {
      await expect(assertPublicUrl("https://example.com/")).resolves.toBeUndefined();
    });
  });

  describe("allows public IPs", () => {
    test.each([
      "http://8.8.8.8/",
      "http://1.1.1.1/",
      "https://93.184.216.34/",
    ])("allows %s", async (url) => {
      await expect(assertPublicUrl(url)).resolves.toBeUndefined();
    });
  });
});

// ─── ssrfSafeFetch ───────────────────────────────────────────────────────────

describe("ssrfSafeFetch", () => {
  test("returns response for non-redirect public URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const resp = await ssrfSafeFetch("https://example.com/", {}, mockFetch);
    expect(resp.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  test("follows safe redirects", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example.com/" },
        }),
      )
      .mockResolvedValueOnce(new Response("final", { status: 200 }));

    const resp = await ssrfSafeFetch("https://example.com/", {}, mockFetch);
    expect(resp.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("blocks redirect to private IP mid-chain", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/" },
      }),
    );

    await expect(ssrfSafeFetch("https://example.com/", {}, mockFetch)).rejects.toThrow(
      "Blocked request to private address",
    );
  });

  test("throws 'Too many redirects' after exceeding limit", async () => {
    // 6 redirects (0..5) + initial = exceeds MAX_REDIRECTS (5)
    // Use literal IP to avoid DNS resolution timeouts in tests
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://8.8.8.8/loop" },
      }),
    );

    await expect(ssrfSafeFetch("https://8.8.8.8/start", {}, mockFetch)).rejects.toThrow(
      "Too many redirects",
    );
  });

  test("returns response when redirect has no Location header", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302 }));

    const resp = await ssrfSafeFetch("https://example.com/", {}, mockFetch);
    expect(resp.status).toBe(302);
  });

  test("rejects initial request to private IP", async () => {
    const mockFetch = vi.fn();
    await expect(ssrfSafeFetch("http://10.0.0.1/", {}, mockFetch)).rejects.toThrow(
      "Blocked request to private address",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
