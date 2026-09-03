// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import {
  MAX_DESIGN_CSS_CHARS,
  MAX_DESIGN_HTML_CHARS,
  MAX_DESIGN_STYLESHEETS,
} from "../sdk/constants.ts";
import { createMockToolContext } from "./_test-utils.ts";
import { resolveAllBuiltins } from "./builtin-tools.ts";
import { createGetPageDesign, parsePage } from "./page-design.ts";

/** The stylesheet-link half of the one parse — what `extractStylesheetUrls` was. */
const extractStylesheetUrls = (html: string, baseUrl: string): string[] =>
  parsePage(html, baseUrl).stylesheetUrls;

const PAGE_URL = "https://example.com/pricing";

/** Route-table fetch: URL → body (string = 200 text, Response = as-is, Error = reject). */
function routedFetch(routes: Record<string, string | Response | Error>): typeof globalThis.fetch {
  return (input) => {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else url = input.url;
    const hit = routes[url];
    if (hit === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (hit instanceof Error) return Promise.reject(hit);
    if (hit instanceof Response) return Promise.resolve(hit);
    return Promise.resolve(new Response(hit));
  };
}

function run(routes: Record<string, string | Response | Error>, url = PAGE_URL) {
  const def = createGetPageDesign(routedFetch(routes));
  return def.execute({ url }, createMockToolContext()) as Promise<Record<string, unknown>>;
}

describe("parsePage", () => {
  test("cuts scripts, styles and comments while leaving surviving markup byte-identical", () => {
    // The stripped markup is assembled by slicing the fetched string, so
    // anything that is not cut is exactly what was fetched — no re-serialize.
    const html = `<div class='a' data-x="1 > 0">keep</div><script>var s = "</div>";</script>`;
    const parsed = parsePage(html, PAGE_URL);
    expect(parsed.html).toBe(`<div class='a' data-x="1 > 0">keep</div>`);
    expect(parsed.inlineCss).toEqual([]);
  });

  test("a <link> written inside a script string is not a stylesheet", () => {
    // Rawtext is the parser's problem — a tag regex over the same bytes saw one.
    const html = `<script>var s = '<link rel="stylesheet" href="/not-real.css">';</script>`;
    expect(parsePage(html, PAGE_URL).stylesheetUrls).toEqual([]);
  });

  test("an unclosed script is cut to the end of the document", () => {
    expect(parsePage("<p>a</p><script>var x = 1", PAGE_URL).html).toBe("<p>a</p>");
  });

  test("<style> bodies are collected raw, un-decoded and blank-free", () => {
    const parsed = parsePage(
      `<style>.a::after { content: "&amp;" }</style><style>  </style><style>.b{}</style>`,
      PAGE_URL,
    );
    expect(parsed.inlineCss).toEqual(['.a::after { content: "&amp;" }', ".b{}"]);
    expect(parsed.html).toBe("");
  });
});

describe("extractStylesheetUrls", () => {
  test("resolves relative hrefs against the page URL, in document order", () => {
    const html = `
      <link rel="stylesheet" href="/main.css">
      <link href="theme.css" rel="stylesheet">
      <link rel="stylesheet" href="https://cdn.example.org/lib.css">`;
    expect(extractStylesheetUrls(html, PAGE_URL)).toEqual([
      "https://example.com/main.css",
      "https://example.com/theme.css",
      "https://cdn.example.org/lib.css",
    ]);
  });

  test("skips non-stylesheet links, non-http(s) hrefs, and duplicates", () => {
    const html = `
      <link rel="icon" href="/favicon.ico">
      <link rel="preload" as="style" href="/preloaded.css">
      <link rel="stylesheet" href="data:text/css,body{}">
      <link rel="stylesheet" href="/main.css">
      <link rel="stylesheet" href="/main.css">
      <link rel="stylesheet">`;
    expect(extractStylesheetUrls(html, PAGE_URL)).toEqual(["https://example.com/main.css"]);
  });

  test('matches rel="stylesheet" inside a multi-value rel, single quotes, and bare values', () => {
    const html = `
      <link rel='alternate stylesheet' href='/alt.css'>
      <link rel=stylesheet href=/bare.css>`;
    expect(extractStylesheetUrls(html, PAGE_URL)).toEqual([
      "https://example.com/alt.css",
      "https://example.com/bare.css",
    ]);
  });

  test("entity-decodes hrefs and survives '>' inside attribute values", () => {
    // Both broke the old tag-regex extraction: an entity-encoded query
    // separator stayed literal (`&amp;` in the fetched URL), and a `>` in a
    // quoted attribute value ended the "tag" early, losing the href.
    const html = `
      <link rel="stylesheet" href="/main.css?family=Inter&amp;display=swap">
      <link title="a > b" rel="stylesheet" href="/after-gt.css">
      <script>var s = '<link rel="stylesheet" href="/not-real.css">';</script>`;
    expect(extractStylesheetUrls(html, PAGE_URL)).toEqual([
      "https://example.com/main.css?family=Inter&display=swap",
      "https://example.com/after-gt.css",
    ]);
  });
});

describe("get_page_design", () => {
  test("returns markup with scripts and comments stripped, classes and inline styles kept", async () => {
    const result = await run({
      [PAGE_URL]: `<html><head><script src="app.js"></script></head>
        <body class="dark"><!-- hero -->
        <script>alert(1)</script>
        <div class="hero" style="color:#123456">Hi</div></body></html>`,
    });
    const html = result.html as string;
    expect(html).not.toContain("script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("hero -->");
    expect(html).toContain('class="hero"');
    expect(html).toContain('style="color:#123456"');
    expect(result.url).toBe(PAGE_URL);
  });

  test("collects <style> blocks as inlineCss and removes them from the markup", async () => {
    const result = await run({
      [PAGE_URL]: `<html><head>
        <style>body { background: #fafafa; }</style>
        <style media="print">.no-print { display: none; }</style>
        </head><body>x</body></html>`,
    });
    expect(result.inlineCss).toBe("body { background: #fafafa; }\n\n.no-print { display: none; }");
    expect(result.html as string).not.toContain("background: #fafafa");
  });

  test("fetches linked stylesheets and returns their CSS", async () => {
    const result = await run({
      [PAGE_URL]: `<link rel="stylesheet" href="/main.css"><body>x</body>`,
      "https://example.com/main.css": ".btn { border-radius: 8px; }",
    });
    expect(result.stylesheets).toEqual([
      { url: "https://example.com/main.css", css: ".btn { border-radius: 8px; }" },
    ]);
  });

  test("a failing stylesheet degrades to a per-sheet error, not a thrown turn", async () => {
    // The rejection stands in for an SSRF-blocked href — page-controlled input.
    const result = await run({
      [PAGE_URL]: `<link rel="stylesheet" href="https://internal.evil/steal.css">
        <link rel="stylesheet" href="/ok.css">`,
      "https://internal.evil/steal.css": new Error("Blocked request to private address"),
      "https://example.com/ok.css": "p{}",
    });
    expect(result.stylesheets).toEqual([
      { url: "https://internal.evil/steal.css", error: "Blocked request to private address" },
      { url: "https://example.com/ok.css", css: "p{}" },
    ]);
  });

  test("non-ok stylesheet responses are reported per sheet", async () => {
    const result = await run({
      [PAGE_URL]: `<link rel="stylesheet" href="/gone.css">`,
      "https://example.com/gone.css": new Response("", { status: 404, statusText: "Not Found" }),
    });
    expect(result.stylesheets).toEqual([
      { url: "https://example.com/gone.css", error: "HTTP 404 Not Found" },
    ]);
  });

  test("caps stylesheet count and reports how many were skipped", async () => {
    const links = Array.from(
      { length: MAX_DESIGN_STYLESHEETS + 2 },
      (_, i) => `<link rel="stylesheet" href="/s${i}.css">`,
    ).join("\n");
    const routes: Record<string, string | Response | Error> = { [PAGE_URL]: links };
    for (let i = 0; i < MAX_DESIGN_STYLESHEETS + 2; i++) {
      routes[`https://example.com/s${i}.css`] = `.s${i}{}`;
    }
    const result = await run(routes);
    expect(result.stylesheets).toHaveLength(MAX_DESIGN_STYLESHEETS);
    expect(result.skippedStylesheets).toBe(2);
  });

  test("caps oversized HTML and CSS with truncation flags", async () => {
    const result = await run({
      [PAGE_URL]: `<style>${"c".repeat(MAX_DESIGN_CSS_CHARS + 10)}</style>
        <link rel="stylesheet" href="/big.css">
        <body>${"x".repeat(MAX_DESIGN_HTML_CHARS + 10)}</body>`,
      "https://example.com/big.css": "y".repeat(MAX_DESIGN_CSS_CHARS + 10),
    });
    expect((result.html as string).length).toBe(MAX_DESIGN_HTML_CHARS);
    expect(result.htmlTruncated).toBe(true);
    expect((result.inlineCss as string).length).toBe(MAX_DESIGN_CSS_CHARS);
    expect(result.inlineCssTruncated).toBe(true);
    expect(result.stylesheets).toEqual([
      {
        url: "https://example.com/big.css",
        css: "y".repeat(MAX_DESIGN_CSS_CHARS),
        truncated: true,
      },
    ]);
  });

  test("omits inlineCss and truncation flags when not applicable", async () => {
    const result = await run({ [PAGE_URL]: "<body>plain</body>" });
    expect(result).not.toHaveProperty("inlineCss");
    expect(result).not.toHaveProperty("htmlTruncated");
    expect(result).not.toHaveProperty("skippedStylesheets");
    expect(result.stylesheets).toEqual([]);
  });

  test("returns an error result for a non-ok page response", async () => {
    const result = await run({
      [PAGE_URL]: new Response("", { status: 403, statusText: "Forbidden" }),
    });
    expect(result).toEqual({ error: "Failed to fetch: 403 Forbidden", url: PAGE_URL });
  });

  test("is registered as a builtin with schema and guidance", () => {
    const { defs, schemas, guidance } = resolveAllBuiltins(["get_page_design"]);
    expect(defs.get_page_design?.execute).toBeTypeOf("function");
    expect(schemas.map((s) => s.name)).toEqual(["get_page_design"]);
    expect(guidance.some((g) => g.includes("get_page_design"))).toBe(true);
  });
});
