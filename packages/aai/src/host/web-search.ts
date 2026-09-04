// Copyright 2025 the AAI authors. MIT license.
/**
 * The `web_search` builtin — keyless search backed by DuckDuckGo, so every
 * agent (and the studio's coding agent) gets search without provisioning a
 * search-API credential. The scraping approach (endpoint, result/snippet
 * selectors, uddg redirect decoding, bot-challenge detection) is ported from
 * openclaw's duckduckgo web-search plugin (MIT,
 * https://github.com/openclaw/openclaw —
 * extensions/duckduckgo/src/ddg-client.ts). This replaced the Brave Search
 * API implementation, which required a per-tenant BRAVE_API_KEY.
 *
 * Two endpoints, one fallback. The primary HTML endpoint
 * (html.duckduckgo.com) challenges datacenter IPs aggressively — deployed
 * agents run in cloud sandboxes, so "returned a bot-detection challenge"
 * was a routine outcome, not an edge case. When the primary answers with a
 * challenge page, an HTTP error, or a thrown fetch, the search retries once
 * against the lite endpoint (lite.duckduckgo.com), which serves a plainer
 * page under a separate rate-limit bucket. Only when both fail does the
 * tool return an error — the primary's, since that is the endpoint whose
 * failure the operator would investigate.
 */

import { Parser } from "htmlparser2";
import { z } from "zod";
import { MAX_HTML_BYTES } from "../sdk/constants.ts";
import type { ToolDef } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";
import { type CappedText, fetchCappedText } from "./_fetch-capped.ts";
import { builtinFetch } from "./ssrf.ts";

const webSearchParams = z.object({
  query: z.string().describe("The search query"),
  max_results: z.number().describe("Maximum number of results to return (default 5)").optional(),
});

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html";
const DDG_LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";
/** DDG serves a stripped page to obvious bots; a browser UA gets results. */
const DDG_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
/** Bare-UA requests with no Accept headers are an easy bot signature. */
const DDG_HEADERS = {
  "User-Agent": DDG_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
const MAX_SEARCH_RESULTS = 10;

/**
 * Collapse one parsed element's text into a single line.
 *
 * The parser hands text over already entity-decoded, so `&nbsp;` has become
 * U+00A0 by the time it arrives — and JS `\s` matches that, so ONE collapse
 * covers the NBSP normalization the regex version needed a separate pass for.
 * (It needed one because it collapsed whitespace BEFORE decoding, while the
 * entity was still literal text.)
 *
 * Concatenating the parser's text nodes also gives the old `<b>`-stripping rule
 * for free: DDG wraps query-match highlights in `<b>` mid-word
 * (`Re<b>sult</b> 1`), and rejoining text nodes closes the word back up, where
 * a generic tag-to-space substitution would have produced `Re sult 1`.
 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Is `name` one of this element's whitespace-separated classes? */
function hasClass(attribs: Record<string, string>, name: string): boolean {
  const className = attribs.class;
  if (className === undefined) return false;
  return className.split(/\s+/).includes(name);
}

/** DDG links route through a redirect whose `uddg` param is the real URL. */
function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const normalized = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    const uddg = new URL(normalized).searchParams.get("uddg");
    if (uddg) return uddg;
  } catch {
    // Not a URL we can parse — fall through to the raw value.
  }
  return rawUrl;
}

/**
 * Challenge markers: classic CAPTCHA forms plus the anomaly interstitial
 * DDG serves to datacenter IPs ("Unfortunately, bots use DuckDuckGo too").
 */
const CHALLENGE_MARKERS =
  /g-recaptcha|are you a human|id="challenge-form"|name="challenge"|anomaly-modal|bots use DuckDuckGo/i;

type SearchResult = { title: string; url: string; description: string };

/**
 * Which elements carry a result, as a tag name plus the class that marks it.
 *
 * A selector pair, not a regex triple, because this is a real streaming parse
 * now — see {@link parseResults}. Note the two endpoints agree on the ORDER and
 * disagree on everything else: the snippet element always FOLLOWS its title
 * link in document order, but on the primary endpoint it is a sibling `<a>` and
 * on the lite one a `<td>` in the next table row. That ordering is the whole
 * correlation rule, and it is what the state machine encodes.
 */
type ResultSelector = { tag: string; className: string };
type EndpointFormat = { title: ResultSelector; snippet: ResultSelector };

/**
 * The primary endpoint: `<a class="result__a" href>title</a>` followed by
 * `<a class="result__snippet">snippet</a>`.
 */
const HTML_FORMAT: EndpointFormat = {
  title: { tag: "a", className: "result__a" },
  snippet: { tag: "a", className: "result__snippet" },
};

/**
 * The lite endpoint: table rows with `<a class='result-link'>` title anchors
 * and `<td class='result-snippet'>` cells.
 */
const LITE_FORMAT: EndpointFormat = {
  title: { tag: "a", className: "result-link" },
  snippet: { tag: "td", className: "result-snippet" },
};

/**
 * Extract results with a real streaming HTML parse (htmlparser2), not a tag
 * regex — the same call `page-design.ts` makes one file over, on the same
 * reasoning and the same already-present dependency.
 *
 * What the six regexes this replaced could not do, all of it silent:
 *
 * - **Attribute order and quote style were part of the pattern.** Matching a
 *   class meant a lookahead over the raw tag text, so `LITE_FORMAT` had already
 *   been forked to accept either quote character, and a `>` inside any quoted
 *   attribute value would have ended the tag early. The parser reports
 *   `attribs` as a decoded record, so neither is expressible.
 * - **Snippets were scoped by BYTE OFFSET** — the slice between one title match
 *   and the next — so any nesting change silently re-pointed a description at
 *   another result's text rather than failing.
 * - **`stripHtml` folded every tag to a space over the whole scoped slice**, so
 *   a `<script>` or `<style>` body sitting between two results would land in a
 *   description verbatim. Rawtext is the parser's problem now.
 *
 * Entity decoding comes with it: htmlparser2 decodes text nodes and attribute
 * values (it depends on `entities` internally, which is why that direct
 * dependency came off this package), so the separate `decodeHTML` pass is gone
 * and an `&amp;` in an href arrives as `&`.
 */
function parseResults(html: string, format: EndpointFormat): SearchResult[] {
  const results: SearchResult[] = [];
  /** The result awaiting the snippet that follows it. */
  let pending: SearchResult | undefined;
  /** Which element's text `ontext` is currently filling, if any. */
  let capturing: "title" | "snippet" | undefined;
  /** Nesting of same-named tags inside it, so `<b>`/`<td>` can't close it early. */
  let depth = 0;
  let text = "";
  let href = "";
  const parser = new Parser({
    onopentag(tag, attribs) {
      if (capturing) {
        if (tag === format[capturing].tag) depth += 1;
        return;
      }
      if (tag === format.title.tag && hasClass(attribs, format.title.className)) {
        // A new title link means the previous result's snippet never arrived.
        // Keep it — a result with no description is still a usable answer.
        if (pending) results.push(pending);
        pending = undefined;
        capturing = "title";
        depth = 0;
        text = "";
        href = attribs.href ?? "";
        return;
      }
      if (pending && tag === format.snippet.tag && hasClass(attribs, format.snippet.className)) {
        capturing = "snippet";
        depth = 0;
        text = "";
      }
    },
    ontext(chunk) {
      if (capturing) text += chunk;
    },
    onclosetag(tag) {
      if (capturing === undefined || tag !== format[capturing].tag) return;
      if (depth > 0) {
        depth -= 1;
        return;
      }
      if (capturing === "title") {
        const title = normalizeText(text);
        const url = decodeDuckDuckGoUrl(href);
        pending = title && url ? { title, url, description: "" } : undefined;
      } else if (pending) {
        pending.description = normalizeText(text);
        results.push(pending);
        pending = undefined;
      }
      capturing = undefined;
      text = "";
    },
  });
  parser.write(html);
  parser.end();
  // A trailing result whose snippet element never appeared.
  if (pending) results.push(pending);
  return results;
}

type SearchAttempt = { ok: true; results: SearchResult[] } | { ok: false; error: string };

async function searchEndpoint(
  fetchFn: typeof globalThis.fetch,
  endpoint: string,
  query: string,
  format: EndpointFormat,
): Promise<SearchAttempt> {
  let page: CappedText;
  try {
    // Bounded at the READ — a results page past MAX_HTML_BYTES is a page whose
    // shape has moved, and the surplus is exactly what the parse cannot use.
    page = await fetchCappedText(`${endpoint}?${new URLSearchParams({ q: query })}`, {
      fetch: fetchFn,
      headers: DDG_HEADERS,
      maxBytes: MAX_HTML_BYTES,
    });
  } catch (err) {
    return { ok: false, error: `Search request failed: ${errorMessage(err)}` };
  }
  if (!page.ok) {
    return { ok: false, error: `Search request failed: ${page.error}` };
  }
  const html = page.text;
  const results = parseResults(html, format);
  // A challenge is decided from the PARSE rather than from a second marker regex
  // over the raw bytes: "the page had result markup" and "we could read it" are
  // then the same question, so a page whose shape moved falls back to the other
  // endpoint instead of confidently answering zero results. The markers stay a
  // text scan because two of them are prose, not markup.
  if (results.length === 0 && CHALLENGE_MARKERS.test(html)) {
    return {
      ok: false,
      error: "Search provider returned a bot-detection challenge — try again later",
    };
  }
  return { ok: true, results };
}

export function createWebSearch(
  fetchFn = builtinFetch(),
): ToolDef<typeof webSearchParams> & { guidance: string } {
  return {
    guidance:
      "Use web_search for factual questions, current events, or anything you are unsure about. " +
      "Search first rather than guessing.",
    description:
      "Search the web for current information, facts, news, or answers to questions. Returns a list of results with title, URL, and description. Use this when the user asks about something you don't know, need up-to-date information, or want to verify facts. No API key required.",
    inputSchema: webSearchParams,
    async execute(args) {
      const { query, max_results: maxResults = 5 } = args;
      const count = Math.max(1, Math.min(maxResults, MAX_SEARCH_RESULTS));
      const primary = await searchEndpoint(fetchFn, DDG_HTML_ENDPOINT, query, HTML_FORMAT);
      if (primary.ok) return primary.results.slice(0, count);
      const fallback = await searchEndpoint(fetchFn, DDG_LITE_ENDPOINT, query, LITE_FORMAT);
      if (fallback.ok) return fallback.results.slice(0, count);
      return { error: primary.error };
    },
  };
}
