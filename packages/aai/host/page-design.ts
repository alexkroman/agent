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
 * fetch, which callers supply as the SSRF-safe one, and each is bounded at the
 * READ by {@link fetchCappedText} rather than buffered and measured after.
 * Stylesheet hrefs come from the fetched page (attacker-controlled), so a href
 * resolving to a private address is rejected per request exactly like a hostile
 * page URL; that rejection degrades to a per-stylesheet error, never a thrown
 * turn.
 *
 * **One parse, and the markup is still the raw bytes.** The page used to be
 * parsed once for its stylesheet links and then walked three more times by
 * regex — `<script>`, `<style>` and comments — over the same string, with the
 * regexes deciding rawtext boundaries the parser beside them already knew (the
 * exact reasoning `web-search.ts` records for abandoning its own tag regexes).
 * {@link parsePage} does all of it in the one parse that was already running,
 * and the stripped markup is assembled by CUTTING the removed ranges out of the
 * fetched string — so what is returned is still the raw bytes, never a
 * parse/serialize round-trip.
 */

import { Parser } from "htmlparser2";
import { z } from "zod";
import {
  HTML_ACCEPT,
  MAX_DESIGN_CSS_CHARS,
  MAX_DESIGN_HTML_CHARS,
  MAX_DESIGN_STYLESHEETS,
  MAX_HTML_BYTES,
} from "../sdk/constants.ts";
import type { ToolDef } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";
import { fetchCappedText } from "./_fetch-capped.ts";

/** Collapse runs of three or more blank lines left behind by a removed block. */
const BLANK_RUN_RE = /\n[ \t]*(?:\n[ \t]*)+\n/g;

/** Elements whose whole subtree carries no visual information for a design read. */
const DROPPED_TAGS = new Set(["script", "style"]);

/**
 * The absolute http(s) URL a `<link rel="stylesheet">` points at, or
 * `undefined` for any other link — a `rel` without the token, a missing href,
 * an unresolvable one, or a `data:`/`javascript:` scheme.
 */
function stylesheetHref(attribs: Record<string, string>, baseUrl: string): string | undefined {
  const rel = attribs.rel;
  if (!(rel && /(?:^|\s)stylesheet(?:\s|$)/i.test(rel))) return;
  const href = attribs.href;
  if (!href) return;
  let resolved: URL;
  try {
    resolved = new URL(href, baseUrl);
  } catch {
    return;
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return;
  return resolved.href;
}

/** What one parse of the page yields. */
export type PageParse = {
  /**
   * Stylesheet URLs from `<link rel="stylesheet" href>` tags, resolved against
   * the page URL, http(s)-only, deduped, in document order.
   */
  stylesheetUrls: string[];
  /** The page's `<style>` bodies, in document order, blanks dropped. */
  inlineCss: string[];
  /** The fetched markup with `<script>`, `<style>` and comments cut out. */
  html: string;
};

/**
 * Read a page once: stylesheet links, inline CSS, and the stripped markup.
 *
 * The parse is a real streaming HTML parse (htmlparser2), which is what makes
 * every one of the three answers trustworthy: attribute values arrive
 * entity-decoded (`&amp;` in an href is `&`), a `>` inside a quoted value does
 * not end a tag, and rawtext is the parser's problem — so a `<link>` written
 * inside a `<script>` string is not a stylesheet, and a `</script>` the script
 * only appears to contain does not end it.
 *
 * Removal is recorded as OFFSET RANGES into `html` and applied by slicing, so
 * everything that survives is byte-identical to what was fetched.
 */
export function parsePage(html: string, baseUrl: string): PageParse {
  const stylesheetUrls: string[] = [];
  const inlineCss: string[] = [];
  /** Half-open `[start, end)` ranges to cut, in ascending, non-overlapping order. */
  const cuts: [number, number][] = [];
  /** The dropped element currently open — they never nest inside each other. */
  let dropped: { tag: string; start: number } | undefined;
  let styleText = "";

  const parser = new Parser({
    onopentag(tagName, attribs) {
      if (dropped) return;
      if (DROPPED_TAGS.has(tagName)) {
        dropped = { tag: tagName, start: parser.startIndex };
        styleText = "";
        return;
      }
      if (tagName !== "link") return;
      const href = stylesheetHref(attribs, baseUrl);
      if (href !== undefined && !stylesheetUrls.includes(href)) stylesheetUrls.push(href);
    },
    ontext(chunk) {
      if (dropped?.tag === "style") styleText += chunk;
    },
    onclosetag(tagName) {
      if (!dropped || tagName !== dropped.tag) return;
      // `endIndex` is the last character of the close tag, hence the +1; an
      // element left unclosed at EOF closes here with the document's own end.
      cuts.push([dropped.start, parser.endIndex + 1]);
      if (dropped.tag === "style") {
        const css = styleText.trim();
        if (css) inlineCss.push(css);
      }
      dropped = undefined;
    },
    oncomment() {
      if (!dropped) cuts.push([parser.startIndex, parser.endIndex + 1]);
    },
  });
  parser.write(html);
  parser.end();

  let stripped = "";
  let last = 0;
  for (const [start, end] of cuts) {
    stripped += html.slice(last, start);
    last = end;
  }
  stripped += html.slice(last);
  return { stylesheetUrls, inlineCss, html: stripped.replace(BLANK_RUN_RE, "\n\n").trim() };
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
    const sheet = await fetchCappedText(url, {
      fetch: fetchFn,
      accept: "text/css,*/*;q=0.1",
      maxBytes: MAX_HTML_BYTES,
    });
    if (!sheet.ok) return { url, error: `HTTP ${sheet.error}` };
    const { text, truncated } = capText(sheet.text, MAX_DESIGN_CSS_CHARS);
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
      const page = await fetchCappedText(url, {
        fetch: fetchFn,
        accept: HTML_ACCEPT,
        maxBytes: MAX_HTML_BYTES,
      });
      if (!page.ok) {
        return { error: `Failed to fetch: ${page.error}`, url };
      }

      // <style> bodies are returned separately as `inlineCss`, so the parse
      // drops them from the markup rather than sending the same bytes twice.
      const parsed = parsePage(page.text, url);
      // Independent fetches, each already degrading to a per-sheet error —
      // run them concurrently so a slow sheet costs the slowest fetch, not
      // the sum of every fetch's timeout budget, inside a voice turn.
      const stylesheets: StylesheetResult[] = await Promise.all(
        parsed.stylesheetUrls
          .slice(0, MAX_DESIGN_STYLESHEETS)
          .map((sheetUrl) => fetchStylesheet(fetchFn, sheetUrl)),
      );

      const html = capText(parsed.html, MAX_DESIGN_HTML_CHARS);
      const css = capText(parsed.inlineCss.join("\n\n"), MAX_DESIGN_CSS_CHARS);

      const skipped = Math.max(0, parsed.stylesheetUrls.length - MAX_DESIGN_STYLESHEETS);
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
