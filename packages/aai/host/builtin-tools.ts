// Copyright 2025 the AAI authors. MIT license.
/**
 * Built-in tool definitions for the AAI agent SDK.
 *
 * In self-hosted mode, these run in-process alongside custom tools.
 * In platform mode, they run on the host process outside the sandbox.
 * Network requests go through the host's fetch proxy (with SSRF protection).
 */

import { convert } from "html-to-text";
import { z } from "zod";
import { EMPTY_PARAMS, type ToolSchema } from "../sdk/_internal-types.ts";
import { FETCH_TIMEOUT_MS, MAX_HTML_BYTES, MAX_PAGE_CHARS } from "../sdk/constants.ts";
import type { ToolDef } from "../sdk/types.ts";
import { createRunCode } from "./_run-code.ts";

export { executeInIsolate } from "./_run-code.ts";

const fetchSignal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

const htmlToText = (html: string): string => convert(html, { wordwrap: false });

// ─── web_search ────────────────────────────────────────────────────────────

const webSearchParams = z.object({
  query: z.string().describe("The search query"),
  max_results: z.number().describe("Maximum number of results to return (default 5)").optional(),
});

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const BraveSearchResponseSchema = z.object({
  web: z
    .object({
      results: z.array(
        z.object({
          title: z.string(),
          url: z.string(),
          description: z.string(),
        }),
      ),
    })
    .optional(),
});

function createWebSearch(
  fetchFn = globalThis.fetch,
): ToolDef<typeof webSearchParams> & { guidance: string } {
  return {
    guidance:
      "Use web_search for factual questions, current events, or anything you are unsure about. " +
      "Search first rather than guessing.",
    description:
      "Search the web for current information, facts, news, or answers to questions. Returns a list of results with title, URL, and description. Use this when the user asks about something you don't know, need up-to-date information, or want to verify facts.",
    parameters: webSearchParams,
    async execute(args, ctx) {
      const { query, max_results: maxResults = 5 } = args;
      const apiKey = ctx.env.BRAVE_API_KEY ?? "";
      if (!apiKey) {
        return { error: "BRAVE_API_KEY is not set — web search unavailable" };
      }
      const url = `${BRAVE_SEARCH_URL}?${new URLSearchParams({
        q: query,
        count: String(maxResults),
        text_decorations: "false",
      })}`;
      const resp = await fetchFn(url, {
        headers: { "X-Subscription-Token": apiKey },
        signal: fetchSignal(),
      });
      if (!resp.ok) {
        return { error: `Search request failed: ${resp.status} ${resp.statusText}` };
      }
      const raw = await resp.json();
      const data = BraveSearchResponseSchema.safeParse(raw);
      if (!data.success) {
        return { error: "Unexpected search response format" };
      }
      return (data.data.web?.results ?? []).slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.url,
        description: r.description,
      }));
    },
  };
}

// ─── visit_webpage ─────────────────────────────────────────────────────────

const visitWebpageParams = z.object({
  url: z.string().describe("The full URL to fetch (e.g., 'https://example.com/page')"),
});

function createVisitWebpage(
  fetchFn = globalThis.fetch,
): ToolDef<typeof visitWebpageParams> & { guidance: string } {
  return {
    guidance:
      "Use visit_webpage to read the full content of a URL when search snippets are not detailed enough.",
    description:
      "Fetch a webpage and return its content as clean text. Use this to read the full content of a URL found via web_search, or any link the user shares. Good for reading articles, documentation, blog posts, or product pages.",
    parameters: visitWebpageParams,
    async execute(args, _ctx) {
      const { url } = args;
      const resp = await fetchFn(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; VoiceAgent/1.0; +https://github.com/AssemblyAI/aai)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: fetchSignal(),
      });
      if (!resp.ok) {
        return { error: `Failed to fetch: ${resp.status} ${resp.statusText}`, url };
      }
      const htmlContent = await resp.text();
      const trimmedHtml =
        htmlContent.length > MAX_HTML_BYTES ? htmlContent.slice(0, MAX_HTML_BYTES) : htmlContent;
      const text = htmlToText(trimmedHtml);
      const truncated = text.length > MAX_PAGE_CHARS;
      const content = truncated ? text.slice(0, MAX_PAGE_CHARS) : text;
      return {
        url,
        content,
        ...(truncated ? { truncated: true, totalChars: text.length } : {}),
      };
    },
  };
}

// ─── fetch_json ────────────────────────────────────────────────────────────

const fetchJsonParams = z.object({
  url: z.string().describe("The URL to fetch JSON from"),
  headers: z
    .record(z.string(), z.string())
    .describe(
      "Optional HTTP headers to include in the request (only safe headers like Accept, Content-Type are allowed)",
    )
    .optional(),
});

/** Headers the LLM must never control — could exfiltrate credentials or manipulate routing. */
const BLOCKED_FETCH_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "host",
  "proxy-authorization",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "fly-client-ip",
]);

function sanitizeHeaders(
  raw: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!raw) return;
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!BLOCKED_FETCH_HEADERS.has(key.toLowerCase())) safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function createFetchJson(
  fetchFn = globalThis.fetch,
): ToolDef<typeof fetchJsonParams> & { guidance: string } {
  return {
    guidance: "Use fetch_json to call REST APIs and retrieve structured JSON data.",
    description:
      "Call a REST API endpoint via HTTP GET and return the JSON response. Use this to fetch structured data from APIs — for example, weather data, stock prices, exchange rates, or any public JSON API. Supports custom headers for authenticated APIs.",
    parameters: fetchJsonParams,
    async execute(args, _ctx) {
      const { url, headers } = args;
      const safeHeaders = sanitizeHeaders(headers);
      const resp = await fetchFn(url, {
        ...(safeHeaders && { headers: safeHeaders }),
        signal: fetchSignal(),
      });
      if (!resp.ok) {
        return { error: `HTTP ${resp.status} ${resp.statusText}`, url };
      }
      try {
        return await resp.json();
      } catch {
        return { error: "Response was not valid JSON", url };
      }
    },
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Options for creating built-in tool definitions. */
export type BuiltinToolOptions = {
  /** Override fetch implementation (defaults to globalThis.fetch). For testing. */
  fetch?: typeof globalThis.fetch;
};

type ToolDefRecord = Record<string, ToolDef<z.ZodObject<z.ZodRawShape>>>;

/** Resolve a builtin name to an array of [toolName, ToolDef] pairs. */
function resolveBuiltin(name: string, opts?: BuiltinToolOptions): [string, ToolDef][] {
  switch (name) {
    case "web_search":
      return [["web_search", createWebSearch(opts?.fetch)]];
    case "visit_webpage":
      return [["visit_webpage", createVisitWebpage(opts?.fetch)]];
    case "fetch_json":
      return [["fetch_json", createFetchJson(opts?.fetch)]];
    case "run_code":
      return [["run_code", createRunCode()]];
    default:
      return [];
  }
}

/** Resolved builtins with defs, schemas, and guidance computed in a single pass. */
export type ResolvedBuiltins = {
  defs: ToolDefRecord;
  schemas: ToolSchema[];
  guidance: string[];
};

/**
 * Resolve all builtin tools in one pass, returning defs, schemas, and guidance.
 * Avoids redundant calls to `resolveBuiltin` and `z.toJSONSchema`.
 */
export function resolveAllBuiltins(
  names: readonly string[],
  opts?: BuiltinToolOptions,
): ResolvedBuiltins {
  const defs: ToolDefRecord = {};
  const schemas: ToolSchema[] = [];
  const guidance: string[] = [];

  for (const name of names) {
    for (const [toolName, def] of resolveBuiltin(name, opts)) {
      defs[toolName] = def;
      schemas.push({
        name: toolName,
        description: def.description,
        parameters: z.toJSONSchema(def.parameters ?? EMPTY_PARAMS) as ToolSchema["parameters"],
      });
      const g = (def as { guidance?: string }).guidance;
      if (g) guidance.push(g);
    }
  }

  return { defs, schemas, guidance };
}
