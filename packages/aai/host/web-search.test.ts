// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { createMockToolContext, fakeFetch } from "./_test-utils.ts";
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
    const result = await tool.execute({ query: "q" }, createMockToolContext());
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
    const result = await tool.execute({ query: "q", max_results: 2 }, createMockToolContext());
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
    const result = await tool.execute({ query: "q" }, createMockToolContext());
    expect(Array.isArray(result)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // Both of these used to assert only `Array.isArray(result)`, which a
  // fallback that never fired satisfies just as well: a 429 answered with `[]`
  // and no second request keeps them green while the tool reports "the web has
  // nothing". The lite endpoint has to be shown to be DIALLED and its rows to
  // be what came back — the sibling above is the model.
  test("a primary HTTP error falls back to the lite endpoint", async () => {
    const mockFetch = fetchByHost(
      new Response("", { status: 429, statusText: "Too Many Requests" }),
      new Response(liteResults),
    );
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await tool.execute({ query: "q" }, createMockToolContext());
    expect(result).toEqual([
      { title: "Lite 1", url: "https://lite.example/1", description: "Lite desc & 1" },
      { title: "Lite 2", url: "https://lite.example/2", description: "Lite desc 2" },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("lite.duckduckgo.com");
  });

  test("a thrown primary fetch falls back instead of propagating", async () => {
    const mockFetch = vi.fn((input: string | URL | Request) =>
      String(input).includes("lite.duckduckgo.com")
        ? Promise.resolve(new Response(liteResults))
        : Promise.reject(new Error("socket hang up")),
    );
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await tool.execute({ query: "q" }, createMockToolContext());
    expect(result).toEqual([
      { title: "Lite 1", url: "https://lite.example/1", description: "Lite desc & 1" },
      { title: "Lite 2", url: "https://lite.example/2", description: "Lite desc 2" },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("lite.duckduckgo.com");
  });

  test("both endpoints challenged returns the primary's error", async () => {
    const mockFetch = fetchByHost(new Response(challenge), new Response(anomaly));
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await tool.execute({ query: "q" }, createMockToolContext());
    expect(result).toMatchObject({ error: expect.stringContaining("bot-detection") });
  });

  test("both endpoints failing HTTP returns the primary's status", async () => {
    const mockFetch = fetchByHost(
      new Response("", { status: 500, statusText: "Internal Server Error" }),
      new Response("", { status: 403, statusText: "Forbidden" }),
    );
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await tool.execute({ query: "q" }, createMockToolContext());
    expect(result).toEqual({ error: "Search request failed: 500 Internal Server Error" });
  });

  test("decodes named entities beyond the old hand-rolled table", async () => {
    // &rsquo;, &eacute;, and &copy; were never in the deleted DDG_NAMED_ENTITIES
    // table. They decode because htmlparser2 decodes text nodes and attribute
    // values itself (on `entities`, which it depends on) — which is why this
    // package no longer declares that dependency directly.
    const page = `
      <div class="result">
        <a class="result__a" href="https://example.com/e">Caf&eacute; guide</a>
        <a class="result__snippet" href="#">It&rsquo;s &copy; 2026 &mdash; really</a>
      </div>`;
    const mockFetch = fetchByHost(new Response(page), new Response(liteResults));
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await tool.execute({ query: "q" }, createMockToolContext());
    expect(result).toEqual([
      {
        title: "Café guide",
        url: "https://example.com/e",
        description: "It’s © 2026 — really",
      },
    ]);
  });

  test("a `>` inside a quoted attribute does not end the tag", async () => {
    // The regex parse this replaced captured attributes with `([^>]*)>`, so the
    // first `>` ended the tag wherever it sat — here mid-`title`, which left the
    // rest of the attribute bleeding into the extracted link text.
    const page = `
      <div class="result">
        <a class="result__a" href="https://example.com/1" title="Compare 1 > 2">Result 1</a>
        <a class="result__snippet" href="#">Desc 1</a>
      </div>`;
    const mockFetch = fetchByHost(new Response(page), new Response(liteResults));
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await tool.execute({ query: "q" }, createMockToolContext());
    expect(result).toEqual([
      { title: "Result 1", url: "https://example.com/1", description: "Desc 1" },
    ]);
  });

  test("a single-quoted class is still a result", async () => {
    // The primary endpoint's regexes hardcoded double quotes. That DDG varies
    // quote style is not hypothetical — the lite format had already been forked
    // to accept either, so the primary was one markup tweak from zero results.
    const page = `
      <div class='result'>
        <a class='result__a' href='https://example.com/1'>Result 1</a>
        <a class='result__snippet' href='#'>Desc 1</a>
      </div>`;
    const mockFetch = fetchByHost(new Response(page), new Response(liteResults));
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await tool.execute({ query: "q" }, createMockToolContext());
    expect(result).toEqual([
      { title: "Result 1", url: "https://example.com/1", description: "Desc 1" },
    ]);
  });

  test("result markup inside a <script> is not a result", async () => {
    // `stripHtml` folded every tag to a space across the whole scoped slice, so
    // a script body was read as ordinary markup and its text could be lifted
    // into a description.
    const page = `
      <div class="result">
        <a class="result__a" href="https://example.com/1">Result 1</a>
        <script>document.write('<a class="result__snippet">injected</a>');</script>
        <a class="result__snippet" href="#">Real desc</a>
      </div>`;
    const mockFetch = fetchByHost(new Response(page), new Response(liteResults));
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await tool.execute({ query: "q" }, createMockToolContext());
    expect(result).toEqual([
      { title: "Result 1", url: "https://example.com/1", description: "Real desc" },
    ]);
  });

  test("a result whose snippet never arrives is still returned", async () => {
    const page = `
      <div class="result">
        <a class="result__a" href="https://example.com/1">Result 1</a>
      </div>`;
    const mockFetch = fetchByHost(new Response(page), new Response(liteResults));
    const tool = createWebSearch(fakeFetch(mockFetch));
    const result = await tool.execute({ query: "q" }, createMockToolContext());
    expect(result).toEqual([{ title: "Result 1", url: "https://example.com/1", description: "" }]);
  });

  test("requests carry browser-like headers", async () => {
    const mockFetch = fetchByHost(new Response(htmlResults), new Response(liteResults));
    const tool = createWebSearch(fakeFetch(mockFetch));
    await tool.execute({ query: "q" }, createMockToolContext());
    const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("Mozilla/5.0");
    expect(headers.Accept).toContain("text/html");
    expect(headers["Accept-Language"]).toBeTruthy();
  });
});
