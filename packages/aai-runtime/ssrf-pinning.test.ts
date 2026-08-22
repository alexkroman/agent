// Copyright 2025 the AAI authors. MIT license.
/**
 * DNS-pinning mechanism tests.
 *
 * These lock in the fix for a bug that made every `https://` request through
 * `ssrfSafeFetch` fail: pinning used to rewrite the URL's hostname to the
 * resolved IP and move the original host into a `Host` header. Node validates
 * TLS certificates against the URL, not that header, so every request died
 * with "Hostname/IP does not match certificate's altnames".
 *
 * The URL must therefore keep its hostname (correct SNI + cert validation)
 * while the connection is still pinned to the already-validated IP via an
 * undici dispatcher, which is what preserves DNS-rebinding protection.
 *
 * Lives in its own file so the `node:dns/promises` mock does not leak into
 * `ssrf.test.ts`, which exercises real resolution failures.
 */

import { describe, expect, test, vi } from "vitest";
import { fakeFetch } from "./_test-utils.ts";

const PINNED_IP = "93.184.216.34";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => ({ address: PINNED_IP, family: 4 })),
}));

import { ssrfSafeFetch } from "@alexkroman1/aai/host-internal";

/** The undici-only `dispatcher` extension to RequestInit. */
type MaybeDispatcher = RequestInit & { dispatcher?: unknown };

/**
 * A stand-in for the injected `fetch`, plus a typed view of what it recorded.
 *
 * Both narrowings live here so no test below carries one: `vi.fn()`'s inferred
 * signature is not `typeof globalThis.fetch`, and the recorded call tuple is
 * typed from that signature rather than from `ssrfSafeFetch`'s call site. The
 * escape-hatch ratchet counts every occurrence, so keep them at this seam.
 */
function okFetch(): {
  fetch: typeof globalThis.fetch;
  firstCall(): [string, MaybeDispatcher];
} {
  const fn = vi.fn(async () => new Response("body", { status: 200 }));
  return {
    fetch: fakeFetch(fn),
    firstCall: () => fn.mock.calls[0] as unknown as [string, MaybeDispatcher],
  };
}

describe("ssrfSafeFetch: DNS pinning", () => {
  test("keeps the original hostname in the request URL", async () => {
    const mockFetch = okFetch();
    await ssrfSafeFetch("https://example.com/page", {}, mockFetch.fetch);

    const [url] = mockFetch.firstCall();
    expect(url).toBe("https://example.com/page");
    // Regression: must not be rewritten to https://93.184.216.34/page
    expect(url).not.toContain(PINNED_IP);
  });

  test("does not override the Host header", async () => {
    const mockFetch = okFetch();
    await ssrfSafeFetch("https://example.com/page", {}, mockFetch.fetch);

    const [, init] = mockFetch.firstCall();
    expect(new Headers(init.headers).has("host")).toBe(false);
  });

  test("pins the connection to the pre-validated IP via a dispatcher", async () => {
    const mockFetch = okFetch();
    await ssrfSafeFetch("https://example.com/page", {}, mockFetch.fetch);

    const [, init] = mockFetch.firstCall();
    expect(init.dispatcher).toBeDefined();
  });

  test("resolves DNS exactly once per hop (single resolution closes the TOCTOU/rebinding window)", async () => {
    const { lookup } = await import("node:dns/promises");
    const lookupMock = vi.mocked(lookup);
    lookupMock.mockClear();
    const mockFetch = okFetch();
    await ssrfSafeFetch("https://example.com/page", {}, mockFetch.fetch);
    // The same resolved IP must feed both the bogon check and the dispatcher
    // pin. A second resolution would reopen the rebinding window the pin closes.
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  test("attaches no dispatcher when the URL is already a literal IP", async () => {
    const mockFetch = okFetch();
    await ssrfSafeFetch(`https://${PINNED_IP}/page`, {}, mockFetch.fetch);

    const [, init] = mockFetch.firstCall();
    expect(init.dispatcher).toBeUndefined();
  });

  test("preserves caller headers while pinning", async () => {
    const mockFetch = okFetch();
    await ssrfSafeFetch(
      "https://example.com/page",
      { headers: { Accept: "application/json" } },
      mockFetch.fetch,
    );

    const [, init] = mockFetch.firstCall();
    expect(new Headers(init.headers).get("accept")).toBe("application/json");
  });
});
