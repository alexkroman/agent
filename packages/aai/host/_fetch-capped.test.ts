// Copyright 2026 the AAI authors. MIT license.
/**
 * The cap has to bound the READ. Every one of these fails against the
 * `await resp.text()` + slice this replaced: that shape buffers the whole body
 * into host memory first, on a URL the model chose, and then measures UTF-16
 * code units against a byte budget.
 */

import { describe, expect, test, vi } from "vitest";
import { TOOL_USER_AGENT } from "../sdk/constants.ts";
import { fetchCappedText } from "./_fetch-capped.ts";
import { fakeFetch } from "./_test-utils.ts";

/** A response whose body is pulled lazily, so we can count what was read. */
function streamed(chunk: Uint8Array, chunks: number): { resp: Response; pulls: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  return { resp: new Response(stream), pulls: () => pulled };
}

const fetchOf = (resp: Response): typeof globalThis.fetch => fakeFetch(() => Promise.resolve(resp));

describe("fetchCappedText", () => {
  test("stops reading once the budget is exceeded and cancels the rest", async () => {
    // 1000 KiB available, 4 KiB budget: an unbounded read pulls all 1000.
    const { resp, pulls } = streamed(new Uint8Array(1024), 1000);
    const result = await fetchCappedText("https://example.com", {
      fetch: fetchOf(resp),
      maxBytes: 4096,
    });

    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(result.ok ? result.text.length : -1).toBe(4096);
    // One chunk past the budget is what makes "there was more" knowable; the
    // stream's own one-chunk read-ahead is the only other slack allowed.
    expect(pulls()).toBeLessThanOrEqual(6);
  });

  test("the budget is BYTES, where the old cap compared UTF-16 code units", async () => {
    // 10 code units, 30 bytes. Against a 12-byte budget the old `.length > max`
    // check passed it whole — a multi-byte body slipped through at ~3x nominal.
    const body = "€".repeat(10);
    const over = await fetchCappedText("https://example.com", {
      fetch: fetchOf(new Response(body)),
      maxBytes: 12,
    });
    expect(over).toMatchObject({ ok: true, truncated: true });

    const exact = await fetchCappedText("https://example.com", {
      fetch: fetchOf(new Response(body)),
      maxBytes: 30,
    });
    expect(exact).toEqual({ ok: true, text: body, truncated: false });
  });

  test("a body that exactly fills the budget is not reported as truncated", async () => {
    const result = await fetchCappedText("https://example.com", {
      fetch: fetchOf(new Response("abcd")),
      maxBytes: 4,
    });
    expect(result).toEqual({ ok: true, text: "abcd", truncated: false });
  });

  test("an HTTP failure is answered, not thrown, with the bare status text", async () => {
    const result = await fetchCappedText("https://example.com", {
      fetch: fetchOf(new Response("body", { status: 404, statusText: "Not Found" })),
      maxBytes: 100,
    });
    // The five callers prefix this differently, so the helper does not.
    expect(result).toEqual({
      ok: false,
      status: 404,
      statusText: "Not Found",
      error: "404 Not Found",
    });
  });

  test("`accept` sends the builtin UA pair; `headers` merges over it", async () => {
    const fetchFn = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response("x")));
    await fetchCappedText("https://example.com", {
      fetch: fakeFetch(fetchFn),
      accept: "text/css",
      headers: { "Accept-Language": "en-US", "User-Agent": "mine" },
      maxBytes: 10,
    });
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({
      "User-Agent": "mine",
      Accept: "text/css",
      "Accept-Language": "en-US",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("no `accept` means the caller owns every header — no UA is added", async () => {
    const fetchFn = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(new Response("x")));
    await fetchCappedText("https://example.com", {
      fetch: fakeFetch(fetchFn),
      headers: { Accept: "application/json" },
      maxBytes: 10,
    });
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({ Accept: "application/json" });
    expect(TOOL_USER_AGENT).not.toBe("");
  });

  test("a bodyless response reads as empty rather than throwing", async () => {
    const result = await fetchCappedText("https://example.com", {
      fetch: fetchOf(new Response(null, { status: 204 })),
      maxBytes: 10,
    });
    expect(result).toEqual({ ok: true, text: "", truncated: false });
  });
});
