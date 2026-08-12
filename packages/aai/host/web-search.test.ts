// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { fakeFetch, mustRun } from "./_test-utils.ts";
import { createWebSearch } from "./web-search.ts";

/** A minimal primary-endpoint (html.duckduckgo.com) results page. */
const htmlResults = `
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F1">Re<b>sult</b> 1</a>
    <a class="result__snippet" href="#">Desc &amp; 1</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://example.com/2">Result 2</a>
    <a class="result__snippet" href="#">Desc&nbsp;2</a>
  </div>`;

/** A minimal lite-endpoint (lite.duckduckgo.com) results page. */
const liteResults = `
  <table>
    <tr><td><a rel="nofollow" href='//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example%2F1' class='result-link'>Lite <b>1</b></a></td></tr>
    <tr><td class='result-snippet'>Lite desc &amp; 1</td></tr>
    <tr><td><a rel="nofollow" href="https://lite.example/2" class="result-link">Lite 2</a></td></tr>
    <tr><td class="result-snippet">Lite&nbsp;desc 2</td></tr>
  </table>`;

const challenge = '<form id="challenge-form">are you a human</form>';
const anomaly = '<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>';

type MockResponse = Response | Promise<Response>;

/** fetch stub answering per host: html.duckduckgo.com vs lite.duckduckgo.com. */
function fetchByHost(html: MockResponse, lite: MockResponse) {
  return vi.fn((input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    return Promise.resolve(url.includes("lite.duckduckgo.com") ? lite : html);
  });
}

describe("web_search fallback", () => {
  test("primary results are returned without touching the lite endpoint", async () => {
    const mockFetch = fetchByHost(new Response(htmlResults), new Response(liteResults));
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await mustRun(tool)({ query: "q" }, {} as never);
    expect(result).toEqual([
      { title: "Result 1", url: "https://example.com/1", description: "Desc & 1" },
      { title: "Result 2", url: "https://example.com/2", description: "Desc 2" },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("html.duckduckgo.com");
  });

  test("a primary bot challenge falls back to the lite endpoint", async () => {
    const mockFetch = fetchByHost(new Response(challenge), new Response(liteResults));
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await mustRun(tool)({ query: "q", max_results: 2 }, {} as never);
    expect(result).toEqual([
      { title: "Lite 1", url: "https://lite.example/1", description: "Lite desc & 1" },
      { title: "Lite 2", url: "https://lite.example/2", description: "Lite desc 2" },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("lite.duckduckgo.com");
  });

  test("the anomaly interstitial counts as a challenge", async () => {
    const mockFetch = fetchByHost(new Response(anomaly), new Response(liteResults));
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await mustRun(tool)({ query: "q" }, {} as never);
    expect(Array.isArray(result)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("a primary HTTP error falls back to the lite endpoint", async () => {
    const mockFetch = fetchByHost(
      new Response("", { status: 429, statusText: "Too Many Requests" }),
      new Response(liteResults),
    );
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await mustRun(tool)({ query: "q" }, {} as never);
    expect(Array.isArray(result)).toBe(true);
  });

  test("a thrown primary fetch falls back instead of propagating", async () => {
    const mockFetch = vi.fn((input: string | URL | Request) =>
      String(input).includes("lite.duckduckgo.com")
        ? Promise.resolve(new Response(liteResults))
        : Promise.reject(new Error("socket hang up")),
    );
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await mustRun(tool)({ query: "q" }, {} as never);
    expect(Array.isArray(result)).toBe(true);
  });

  test("both endpoints challenged returns the primary's error", async () => {
    const mockFetch = fetchByHost(new Response(challenge), new Response(anomaly));
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await mustRun(tool)({ query: "q" }, {} as never);
    expect(result).toMatchObject({ error: expect.stringContaining("bot-detection") });
  });

  test("both endpoints failing HTTP returns the primary's status", async () => {
    const mockFetch = fetchByHost(
      new Response("", { status: 500, statusText: "Internal Server Error" }),
      new Response("", { status: 403, statusText: "Forbidden" }),
    );
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await mustRun(tool)({ query: "q" }, {} as never);
    expect(result).toEqual({ error: "Search request failed: 500 Internal Server Error" });
  });

  test("decodes named entities beyond the old hand-rolled table", async () => {
    // &rsquo;, &eacute;, and &copy; were never in the deleted DDG_NAMED_ENTITIES
    // table — they only decode because the `entities` package knows all of HTML.
    const page = `
      <div class="result">
        <a class="result__a" href="https://example.com/e">Caf&eacute; guide</a>
        <a class="result__snippet" href="#">It&rsquo;s &copy; 2026 &mdash; really</a>
      </div>`;
    const mockFetch = fetchByHost(new Response(page), new Response(liteResults));
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await mustRun(tool)({ query: "q" }, {} as never);
    expect(result).toEqual([
      {
        title: "Café guide",
        url: "https://example.com/e",
        description: "It’s © 2026 — really",
      },
    ]);
  });

  test("requests carry browser-like headers", async () => {
    const mockFetch = fetchByHost(new Response(htmlResults), new Response(liteResults));
    const tool = createWebSearch(fakeFetch(mockFetch));
    await mustRun(tool)({ query: "q" }, {} as never);
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("Mozilla/5.0");
    expect(headers.Accept).toContain("text/html");
    expect(headers["Accept-Language"]).toBeTruthy();
  });
});
