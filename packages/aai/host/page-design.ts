// Copyright 2026 the AAI authors. MIT license.
/**
 * `get_page_design` — fetch a webpage's raw HTML and CSS so an agent can
 * study or mimic another site's visual design.
 *
 * `visit_webpage` flattens a page to readable text, which throws away
 * exactly what a design task needs: markup structure, class names, inline
 * `style` attributes, and the stylesheets behind them. This builtin keeps
 * those. It strips what carries no visual information (scripts, HTML
 * comments), returns the page's `<style>` blocks as one CSS string, and
 * fetches its `<link rel="stylesheet">` targets.
 *
 * Every request — the page and each stylesheet — goes through the injected
 * fetch, which callers supply as the SSRF-safe one. Stylesheet hrefs come
 * from the fetched page (attacker-controlled), so a href resolving to a
 * private address is rejected per request exactly like a hostile page URL;
 * that rejection degrades to a per-stylesheet error, never a thrown turn.
 */

import { z } from "zod";
import {
  FETCH_TIMEOUT_MS,
  HTML_ACCEPT,
  MAX_DESIGN_CSS_CHARS,
  MAX_DESIGN_HTML_CHARS,
  MAX_DESIGN_STYLESHEETS,
  MAX_HTML_BYTES,
  TOOL_USER_AGENT,
} from "../sdk/constants.ts";
import type { ToolDef } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";

const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const LINK_TAG_RE = /<link\b[^>]*>/gi;

/** Match one attribute in a raw tag string (quoted or bare value). */
function attrRegExp(name: string): RegExp {
  return new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
}

const REL_ATTR_RE = attrRegExp("rel");
const HREF_ATTR_RE = attrRegExp("href");

/** Read one attribute out of a raw tag string. */
function attr(tag: string, re: RegExp): string | undefined {
  const match = tag.match(re);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/**
 * Stylesheet URLs from `<link rel="stylesheet" href>` tags, resolved against
 * the page URL, http(s)-only, deduped, in document order.
 */
export function extractStylesheetUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(LINK_TAG_RE)) {
    const tag = match[0];
    const rel = attr(tag, REL_ATTR_RE);
    if (!(rel && /(?:^|\s)stylesheet(?:\s|$)/i.test(rel))) continue;
    const href = attr(tag, HREF_ATTR_RE);
    if (!href) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    if (!urls.includes(resolved.href)) urls.push(resolved.href);
  }
  return urls;
}

function capText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

type StylesheetResult =
  | { url: string; css: string; truncated?: true }
  | { url: string; error: string };

async function fetchStylesheet(
  fetchFn: typeof globalThis.fetch,
  url: string,
): Promise<StylesheetResult> {
  try {
    const resp = await fetchFn(url, {
      headers: { "User-Agent": TOOL_USER_AGENT, Accept: "text/css,*/*;q=0.1" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return { url, error: `HTTP ${resp.status} ${resp.statusText}` };
    const body = (await resp.text()).slice(0, MAX_HTML_BYTES);
    const { text, truncated } = capText(body, MAX_DESIGN_CSS_CHARS);
    return { url, css: text, ...(truncated && { truncated: true as const }) };
  } catch (err) {
    // A stylesheet href is page-controlled — an SSRF rejection or network
    // failure on one sheet must not throw away the page and the other sheets.
    return { url, error: errorMessage(err) };
  }
}

const getPageDesignParams = z.object({
  url: z.string().describe("The full URL of the page whose design to fetch"),
});

/**
 * Build the `get_page_design` tool. `fetchFn` is required (no default) so this
 * module stays independent of `builtin-tools.ts` — the registry there injects
 * its SSRF-safe fetch.
 */
export function createGetPageDesign(
  fetchFn: typeof globalThis.fetch,
): ToolDef<typeof getPageDesignParams> & { guidance: string } {
  return {
    guidance:
      "Use get_page_design when you need a page's actual HTML structure and CSS — for example " +
      "to mimic or adapt another website's visual design. It returns markup and stylesheets, " +
      "not readable text; use visit_webpage when you only need to read a page's content.",
    description:
      "Fetch a webpage's raw HTML and CSS: the markup (scripts and comments stripped, class " +
      "names and inline styles kept), its <style> blocks, and its linked stylesheets. Use this " +
      "to study or mimic another website's design — colors, fonts, layout, spacing. For " +
      "reading a page's text content, use visit_webpage instead.",
    inputSchema: getPageDesignParams,
    async execute(args, _ctx) {
      const { url } = args;
      const resp = await fetchFn(url, {
        headers: { "User-Agent": TOOL_USER_AGENT, Accept: HTML_ACCEPT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        return { error: `Failed to fetch: ${resp.status} ${resp.statusText}`, url };
      }
      const rawHtml = (await resp.text()).slice(0, MAX_HTML_BYTES);

      const inlineCss = [...rawHtml.matchAll(STYLE_RE)]
        .map((m) => (m[1] ?? "").trim())
        .filter(Boolean)
        .join("\n\n");

      const sheetUrls = extractStylesheetUrls(rawHtml, url);
      // Independent fetches, each already degrading to a per-sheet error —
      // run them concurrently so a slow sheet costs the slowest fetch, not
      // the sum of every fetch's timeout budget, inside a voice turn.
      const stylesheets: StylesheetResult[] = await Promise.all(
        sheetUrls
          .slice(0, MAX_DESIGN_STYLESHEETS)
          .map((sheetUrl) => fetchStylesheet(fetchFn, sheetUrl)),
      );

      // <style> bodies are returned separately as `inlineCss`, so drop them
      // from the markup rather than sending the same bytes twice.
      const stripped = rawHtml
        .replace(SCRIPT_RE, "")
        .replace(STYLE_RE, "")
        .replace(COMMENT_RE, "")
        .replace(/\n[ \t]*(?:\n[ \t]*)+\n/g, "\n\n");
      const html = capText(stripped.trim(), MAX_DESIGN_HTML_CHARS);
      const css = capText(inlineCss, MAX_DESIGN_CSS_CHARS);

      const skipped = sheetUrls.length - Math.min(sheetUrls.length, MAX_DESIGN_STYLESHEETS);
      return {
        url,
        html: html.text,
        ...(html.truncated && { htmlTruncated: true }),
        ...(css.text && { inlineCss: css.text }),
        ...(css.truncated && { inlineCssTruncated: true }),
        stylesheets,
        ...(skipped > 0 && { skippedStylesheets: skipped }),
      };
    },
  };
}
