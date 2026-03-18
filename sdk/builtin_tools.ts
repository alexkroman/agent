// Copyright 2025 the AAI authors. MIT license.
/**
 * Built-in tool definitions for the AAI agent SDK.
 *
 * These tools run inside the sandboxed worker alongside custom tools.
 * Network requests go through the host's fetch proxy (with SSRF protection).
 *
 * @module
 */

import { z } from "zod";
import { EMPTY_PARAMS, type ToolSchema } from "./_internal_types.ts";
import type { ToolDef } from "./types.ts";

// ─── HTML to text ──────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n /g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

function createWebSearch(): ToolDef<typeof webSearchParams> {
  return {
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
      const resp = await fetch(url, {
        headers: { "X-Subscription-Token": apiKey },
        signal: ctx.abortSignal ?? AbortSignal.timeout(15_000),
      });
      if (!resp.ok) return [];
      const raw = await resp.json();
      const data = BraveSearchResponseSchema.safeParse(raw);
      if (!data.success) return [];
      return (data.data.web?.results ?? []).slice(0, maxResults).map((r) => ({
        title: r.title,
        url: r.url,
        description: r.description,
      }));
    },
  };
}

// ─── visit_webpage ─────────────────────────────────────────────────────────

const MAX_PAGE_CHARS = 10_000;
const MAX_HTML_BYTES = 200_000;

const visitWebpageParams = z.object({
  url: z.string().describe("The full URL to fetch (e.g., 'https://example.com/page')"),
});

function createVisitWebpage(): ToolDef<typeof visitWebpageParams> {
  return {
    description:
      "Fetch a webpage and return its content as clean text. Use this to read the full content of a URL found via web_search, or any link the user shares. Good for reading articles, documentation, blog posts, or product pages.",
    parameters: visitWebpageParams,
    async execute(args, ctx) {
      const { url } = args;
      const resp = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; VoiceAgent/1.0; +https://github.com/AssemblyAI/aai)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: ctx.abortSignal ?? AbortSignal.timeout(15_000),
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
    .describe("Optional HTTP headers to include in the request")
    .optional(),
});

function createFetchJson(): ToolDef<typeof fetchJsonParams> {
  return {
    description:
      "Call a REST API endpoint via HTTP GET and return the JSON response. Use this to fetch structured data from APIs — for example, weather data, stock prices, exchange rates, or any public JSON API. Supports custom headers for authenticated APIs.",
    parameters: fetchJsonParams,
    async execute(args, ctx) {
      const { url, headers } = args;
      const resp = await fetch(url, {
        ...(headers && { headers }),
        signal: ctx.abortSignal ?? AbortSignal.timeout(15_000),
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

// ─── run_code ──────────────────────────────────────────────────────────────

const runCodeParams = z.object({
  code: z.string().describe("JavaScript code to execute. Use console.log() for output."),
});

function createRunCode(): ToolDef<typeof runCodeParams> {
  return {
    description:
      "Execute JavaScript code in a secure sandbox and return the output. Use this for calculations, data transformations, string manipulation, or any task that benefits from running code. Output is captured from console.log(). No network or filesystem access.",
    parameters: runCodeParams,
    async execute(args) {
      const { code } = args;
      const output: string[] = [];
      function capture(...captureArgs: unknown[]) {
        output.push(captureArgs.map(String).join(" "));
      }
      const fakeConsole = {
        log: capture,
        info: capture,
        warn: capture,
        error: capture,
        debug: capture,
      };
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      try {
        const fn = new AsyncFunction("console", code);
        await fn(fakeConsole);
        const result = output.join("\n").trim();
        return result || "Code ran successfully (no output)";
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ─── vector_search ─────────────────────────────────────────────────────────

const vectorSearchParams = z.object({
  query: z
    .string()
    .describe(
      "Short keyword query to search the knowledge base. Use specific topic " +
        "terms, not full sentences. Do NOT include the company or product name " +
        "since all documents are from the same source. For example, if the user " +
        'asks "how much does Acme cost", search for "pricing plans rates".',
    ),
  topK: z.number().describe("Maximum results to return (default: 5)").optional(),
});

/** Callback for proxying vector search through the host RPC. */
export type VectorSearchFn = (query: string, topK: number) => Promise<string>;

function createVectorSearch(vectorSearchFn: VectorSearchFn): ToolDef<typeof vectorSearchParams> {
  return {
    description:
      "Search the agent's knowledge base for relevant information. Use this when the user asks a question that might be answered by previously ingested documents or data. Returns the most relevant matches ranked by similarity.",
    parameters: vectorSearchParams,
    async execute(args) {
      const { query, topK = 5 } = args;
      return vectorSearchFn(query, topK);
    },
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Options for creating built-in tool definitions. */
export type BuiltinToolOptions = {
  /** RPC callback for vector_search (proxied through host). */
  vectorSearch?: VectorSearchFn;
};

/**
 * Create built-in tool definitions for the given tool names.
 *
 * @param names - Built-in tool names from the agent config.
 * @param opts - Options including RPC callbacks for host-proxied tools.
 * @returns A record of tool name → ToolDef.
 */
/** A record of tool name → ToolDef with any Zod object parameters. */
type ToolDefRecord = Record<string, ToolDef<z.ZodObject<z.ZodRawShape>>>;

export function getBuiltinToolDefs(
  names: readonly string[],
  opts?: BuiltinToolOptions,
): ToolDefRecord {
  const defs: ToolDefRecord = {};
  for (const name of names) {
    switch (name) {
      case "web_search":
        defs[name] = createWebSearch();
        break;
      case "visit_webpage":
        defs[name] = createVisitWebpage();
        break;
      case "fetch_json":
        defs[name] = createFetchJson();
        break;
      case "run_code":
        defs[name] = createRunCode();
        break;
      case "vector_search":
        if (opts?.vectorSearch) {
          defs[name] = createVectorSearch(opts.vectorSearch);
        }
        break;
    }
  }
  return defs;
}

/** All available tool creators, keyed by builtin tool name. */
const TOOL_CREATORS: Record<string, () => ToolDef> = {
  web_search: createWebSearch,
  visit_webpage: createVisitWebpage,
  fetch_json: createFetchJson,
  run_code: createRunCode,
  // vector_search uses a stub for schema generation
  vector_search: () => createVectorSearch(async () => ""),
};

/**
 * Returns JSON tool schemas for the specified builtin tools.
 *
 * Used by both the worker (to report schemas) and the server (to
 * assemble tool lists for the LLM).
 */
export function getBuiltinToolSchemas(names: readonly string[]): ToolSchema[] {
  return names.flatMap((name) => {
    const creator = TOOL_CREATORS[name];
    if (!creator) return [];
    const def = creator();
    return [
      {
        name,
        description: def.description,
        parameters: z.toJSONSchema(def.parameters ?? EMPTY_PARAMS) as ToolSchema["parameters"],
      },
    ];
  });
}
