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

import { z } from "zod";
import { FETCH_TIMEOUT_MS } from "../sdk/constants.ts";
import type { ToolDef } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";
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

const DDG_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#x27;": "'",
  "&#x2f;": "/",
  "&nbsp;": " ",
  "&ndash;": "-",
  "&mdash;": "--",
  "&hellip;": "...",
  "&amp;": "&",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const named = DDG_NAMED_ENTITIES[entity.toLowerCase()];
    if (named !== undefined) return named;
    const numeric = /^&#(x?)([0-9a-f]+);$/i.exec(entity);
    if (!numeric) return entity;
    const code = Number.parseInt(numeric[2] ?? "", numeric[1] ? 16 : 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
  });
}

function stripHtml(html: string): string {
  // Match highlights (<b>) can occur inside words — remove without spacing.
  return html
    .replace(/<\/?b\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

/** No results markup + challenge markers = we're being asked to prove humanity. */
function isBotChallenge(html: string, resultMarker: RegExp): boolean {
  if (resultMarker.test(html)) return false;
  return CHALLENGE_MARKERS.test(html);
}

type SearchResult = { title: string; url: string; description: string };

type EndpointFormat = {
  /** Presence of this marker means the page carries real results. */
  resultMarker: RegExp;
  /** Matches one result anchor: [1] = attributes, [2] = title markup. */
  resultRegex: RegExp;
  /** Finds the next result anchor, to scope each snippet search. */
  nextResultRegex: RegExp;
  /** Matches the snippet element within one result's scope. */
  snippetRegex: RegExp;
};

// The primary endpoint's results: <a class="result__a" href=...>title</a>
// followed by <a class="result__snippet" ...>snippet</a>.
const HTML_FORMAT: EndpointFormat = {
  resultMarker: /class="[^"]*\bresult__a\b[^"]*"/i,
  resultRegex: /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi,
  nextResultRegex: /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*>/i,
  snippetRegex: /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i,
};

// The lite endpoint's results: table rows with <a class='result-link'>
// title anchors and <td class='result-snippet'> cells. Quote style varies,
// so class/href attributes accept either quote.
const LITE_FORMAT: EndpointFormat = {
  resultMarker: /class=['"][^'"]*\bresult-link\b[^'"]*['"]/i,
  resultRegex: /<a\b(?=[^>]*\bclass=['"][^'"]*\bresult-link\b[^'"]*['"])([^>]*)>([\s\S]*?)<\/a>/gi,
  nextResultRegex: /<a\b(?=[^>]*\bclass=['"][^'"]*\bresult-link\b[^'"]*['"])[^>]*>/i,
  snippetRegex:
    /<td\b(?=[^>]*\bclass=['"][^'"]*\bresult-snippet\b[^'"]*['"])[^>]*>([\s\S]*?)<\/td>/i,
};

function parseResults(html: string, format: EndpointFormat): SearchResult[] {
  const results: SearchResult[] = [];
  for (const match of html.matchAll(format.resultRegex)) {
    const rawUrl = /\bhref=["']([^"']*)["']/i.exec(match[1] ?? "")?.[1] ?? "";
    // The snippet element sits between this result link and the next one.
    const trailing = html.slice((match.index ?? 0) + match[0].length);
    const nextAt = trailing.search(format.nextResultRegex);
    const scoped = nextAt >= 0 ? trailing.slice(0, nextAt) : trailing;
    const title = decodeHtmlEntities(stripHtml(match[2] ?? ""));
    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl));
    const description = decodeHtmlEntities(stripHtml(format.snippetRegex.exec(scoped)?.[1] ?? ""));
    if (title && url) results.push({ title, url, description });
  }
  return results;
}

type SearchAttempt = { ok: true; results: SearchResult[] } | { ok: false; error: string };

async function searchEndpoint(
  fetchFn: typeof globalThis.fetch,
  endpoint: string,
  query: string,
  format: EndpointFormat,
): Promise<SearchAttempt> {
  let resp: Response;
  try {
    resp = await fetchFn(`${endpoint}?${new URLSearchParams({ q: query })}`, {
      headers: DDG_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `Search request failed: ${errorMessage(err)}` };
  }
  if (!resp.ok) {
    return { ok: false, error: `Search request failed: ${resp.status} ${resp.statusText}` };
  }
  const html = await resp.text();
  if (isBotChallenge(html, format.resultMarker)) {
    return {
      ok: false,
      error: "Search provider returned a bot-detection challenge — try again later",
    };
  }
  return { ok: true, results: parseResults(html, format) };
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
    parameters: webSearchParams,
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
