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

import { ssrfSafeFetch } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { fakeFetch } from "./_test-utils.ts";

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
      // The message names the branch that must have raised it. `"Blocked"`
      // alone is shared by every failure mode in the module, DNS included —
      // see the chain-validation specs below for what that hid.
      await expect(ssrfSafeFetch("https://93.184.216.34/", {}, fakeFetch(fetchFn))).rejects.toThrow(
        "Blocked request to private address: 127.0.0.1",
      );
      // Screened BEFORE the hop is requested, so the private target is never
      // fetched: one call, and it is the start URL.
      expect(fetchFn).toHaveBeenCalledTimes(1);
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
  // ── Why these two start from an IP LITERAL, and assert a call count ──
  //
  // They used to start from `https://public.example.com/`, which is NXDOMAIN.
  // `ssrfSafeFetch` resolves the INITIAL url before it ever calls `fetchFn`,
  // and a resolution failure is wrapped in the same `Blocked request: …`
  // error the redirect guard raises — so `rejects.toThrow("Blocked")` was
  // satisfied by the DNS lookup, with **zero** fetch calls made and the
  // redirect guard never reached. Deleting the re-screen from `ssrfSafeFetch`
  // left both green, i.e. the two threats this module exists for were covered
  // by nothing.
  //
  // Three things keep that from coming back: a public IP literal (no DNS at
  // all, so the only reachable rejection is the redirect screen), a message
  // assertion naming the branch rather than the shared `"Blocked"` prefix,
  // and a call count — the guard runs BEFORE the hop is requested, so exactly
  // one fetch happens and it is the start URL.
  const START = "https://93.184.216.34/";

  test("ssrfSafeFetch rejects redirect to private IP", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === START) {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1/admin" },
        });
      }
      throw new Error(`redirect target must never be fetched: ${url}`);
    });

    await expect(ssrfSafeFetch(START, {}, fakeFetch(mockFetch))).rejects.toThrow(
      "Blocked request to private address: 127.0.0.1",
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(START, expect.anything());
  });

  test("ssrfSafeFetch rejects redirect to cloud metadata", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url === START) {
        return new Response(null, {
          status: 301,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      throw new Error(`redirect target must never be fetched: ${url}`);
    });

    await expect(ssrfSafeFetch(START, {}, fakeFetch(mockFetch))).rejects.toThrow(
      "Blocked request to private address: 169.254.169.254",
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(START, expect.anything());
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

    // MAX_REDIRECTS = 5, and the contract is an EXACT count: the loop makes
    // five requests and then gives up. `toBeLessThanOrEqual` also passed at 1,
    // i.e. it could not tell "follows the chain five deep" from "refuses to
    // follow at all" — the two behaviours this bound sits between.
    expect(callCount).toBe(5);
  });

  test("ssrfSafeFetch re-validates each hop in redirect chain", async () => {
    let callCount = 0;
    // Use a public IP literal to avoid DNS lookups that cause timeouts
    const mockFetch = vi.fn(async (url: string) => {
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
      throw new Error(`redirect target must never be fetched: ${url}`);
    });

    await expect(
      ssrfSafeFetch("https://93.184.216.34/start", {}, fakeFetch(mockFetch)),
    ).rejects.toThrow("Blocked request to private address: 192.168.1.1");
    // Three hops requested; the fourth — the private one — never is.
    expect(callCount).toBe(3);
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
