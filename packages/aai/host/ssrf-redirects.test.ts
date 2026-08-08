// Copyright 2026 the AAI authors. MIT license.
/**
 * SSRF redirect-chain validation.
 *
 * Split from `ssrf.test.ts` (which was over the 700-line test cap) on a real
 * seam rather than an arbitrary one: following a redirect is its own security
 * surface — every hop is re-screened, credentials are stripped when the chain
 * leaves its original origin, and the chain is bounded. The boundary specs
 * here came out of a Stryker run in which every mutant of the
 * `resp.status < 300 || resp.status >= 400` condition survived.
 */

import { describe, expect, test, vi } from "vitest";
import { fakeFetch } from "./_test-utils.ts";
import { ssrfSafeFetch } from "./ssrf.ts";

describe("SSRF: redirect status boundaries", () => {
  // `resp.status < 300 || resp.status >= 400` decides what counts as a
  // redirect. Every boundary mutant survived — `<=`/`>`/`&&`/`if (false)` —
  // because no spec used a status at an edge, so nothing pinned which
  // responses get followed and which are handed straight back.
  test.each([200, 204, 299, 400, 404, 500])(
    "a %i response is returned, not followed",
    async (status) => {
      const fetchFn = vi.fn(
        // `null` body: 204 forbids one, and `new Response("")` throws for it.
        async () => new Response(null, { status, headers: { Location: "http://127.0.0.1/" } }),
      );
      const resp = await ssrfSafeFetch("https://93.184.216.34/", {}, fakeFetch(fetchFn));
      // The Location header is present and must be IGNORED at these statuses;
      // following it would reach a private address.
      expect(resp.status).toBe(status);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    },
  );

  test.each([300, 301, 302, 307, 308])(
    "a %i response IS followed and re-screened",
    async (status) => {
      const fetchFn = vi.fn(
        async () => new Response(null, { status, headers: { Location: "http://127.0.0.1/admin" } }),
      );
      await expect(ssrfSafeFetch("https://93.184.216.34/", {}, fakeFetch(fetchFn))).rejects.toThrow(
        "Blocked",
      );
    },
  );

  test("a redirect status with no Location header ends the chain", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302 }));
    const resp = await ssrfSafeFetch("https://93.184.216.34/", {}, fakeFetch(fetchFn));
    expect(resp.status).toBe(302);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

// ── Redirect Chain Validation ──────────────────────────────────────────

describe("SSRF: redirect chain validation", () => {
  test("ssrfSafeFetch rejects redirect to private IP", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === "https://public.example.com/") {
        return new Response("", {
          status: 302,
          headers: { Location: "http://127.0.0.1/admin" },
        });
      }
      return new Response("should not reach");
    });

    await expect(
      ssrfSafeFetch("https://public.example.com/", {}, fakeFetch(mockFetch)),
    ).rejects.toThrow("Blocked");
  });

  test("ssrfSafeFetch rejects redirect to cloud metadata", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === "https://public.example.com/") {
        return new Response("", {
          status: 301,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      return new Response("should not reach");
    });

    await expect(
      ssrfSafeFetch("https://public.example.com/", {}, fakeFetch(mockFetch)),
    ).rejects.toThrow("Blocked");
  });

  test("ssrfSafeFetch enforces max redirect limit", async () => {
    let callCount = 0;
    // Use a public IP literal to avoid DNS lookups that cause timeouts
    const mockFetch = vi.fn(async () => {
      callCount++;
      return new Response("", {
        status: 302,
        headers: { Location: `https://93.184.216.34/hop-${callCount}` },
      });
    });

    await expect(
      ssrfSafeFetch("https://93.184.216.34/start", {}, fakeFetch(mockFetch)),
    ).rejects.toThrow("Too many redirects");

    // MAX_REDIRECTS = 5, so at most 5 fetch calls
    expect(callCount).toBeLessThanOrEqual(5);
  });

  test("ssrfSafeFetch re-validates each hop in redirect chain", async () => {
    let callCount = 0;
    // Use a public IP literal to avoid DNS lookups that cause timeouts
    const mockFetch = vi.fn(async (_url: string) => {
      callCount++;
      if (callCount <= 2) {
        return new Response("", {
          status: 302,
          headers: { Location: "https://93.184.216.34/safe-hop" },
        });
      }
      // Third redirect goes to private IP
      if (callCount === 3) {
        return new Response("", {
          status: 302,
          headers: { Location: "http://192.168.1.1/" },
        });
      }
      return new Response("should not reach");
    });

    await expect(
      ssrfSafeFetch("https://93.184.216.34/start", {}, fakeFetch(mockFetch)),
    ).rejects.toThrow("Blocked");
  });

  test("strips credential headers on a cross-origin redirect", async () => {
    // Two public IP literals = two origins, no DNS. The token must not follow
    // the redirect off its original origin (open-redirect exfiltration guard).
    const seen: Record<string, string | null>[] = [];
    const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const h = init.headers as Headers;
      seen.push({
        authorization: h.get("authorization"),
        cookie: h.get("cookie"),
      });
      if (seen.length === 1) {
        return new Response("", { status: 302, headers: { Location: "https://8.8.8.8/next" } });
      }
      return new Response("ok");
    });

    await ssrfSafeFetch(
      "https://93.184.216.34/start",
      { headers: { Authorization: "Bearer secret", Cookie: "sid=1" } },
      fakeFetch(mockFetch),
    );

    expect(seen[0]).toEqual({ authorization: "Bearer secret", cookie: "sid=1" });
    expect(seen[1]).toEqual({ authorization: null, cookie: null });
  });

  test("keeps credential headers on a same-origin redirect", async () => {
    const seen: Array<string | null> = [];
    const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Headers).get("authorization"));
      if (seen.length === 1) {
        return new Response("", {
          status: 302,
          headers: { Location: "https://93.184.216.34/next" },
        });
      }
      return new Response("ok");
    });

    await ssrfSafeFetch(
      "https://93.184.216.34/start",
      { headers: { Authorization: "Bearer secret" } },
      fakeFetch(mockFetch),
    );

    expect(seen).toEqual(["Bearer secret", "Bearer secret"]);
  });

  test("ssrfSafeFetch handles relative redirect URLs", async () => {
    // Use a public IP literal to avoid DNS lookups that cause timeouts
    const mockFetch = vi.fn(async (url: string) => {
      if (url === "https://93.184.216.34/page") {
        return new Response("", {
          status: 302,
          headers: { Location: "/other-page" },
        });
      }
      return new Response("final content", { status: 200 });
    });

    const res = await ssrfSafeFetch("https://93.184.216.34/page", {}, fakeFetch(mockFetch));
    expect(res.status).toBe(200);
    // The relative URL should resolve to the same origin
    expect(mockFetch).toHaveBeenCalledWith("https://93.184.216.34/other-page", expect.anything());
  });
});
