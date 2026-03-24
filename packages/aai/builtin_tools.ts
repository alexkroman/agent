// Copyright 2025 the AAI authors. MIT license.
/**
 * Built-in tool definitions for the AAI agent SDK.
 *
 * These tools run inside the sandboxed worker alongside custom tools.
 * Network requests go through the host's fetch proxy (with SSRF protection).
 *
 * @module
 */

import { convert } from "html-to-text";
import { z } from "zod";
import { EMPTY_PARAMS, type ToolSchema } from "./_internal_types.ts";
import { errorMessage } from "./_utils.ts";
import { type ToolDef, tool } from "./types.ts";

/** Per-fetch timeout for network tools — tighter than the overall tool timeout. */
const FETCH_TIMEOUT_MS = 15_000;

/** Timeout for sandboxed code execution. */
const RUN_CODE_TIMEOUT = 5_000;

/** Create a fetch timeout signal. */
function fetchSignal(): AbortSignal {
  return AbortSignal.timeout(FETCH_TIMEOUT_MS);
}

// ─── HTML to text ──────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return convert(html, { wordwrap: false });
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

function createWebSearch(fetchFn = globalThis.fetch): ToolDef<typeof webSearchParams> {
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
      const resp = await fetchFn(url, {
        headers: { "X-Subscription-Token": apiKey },
        signal: fetchSignal(),
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

function createVisitWebpage(fetchFn = globalThis.fetch): ToolDef<typeof visitWebpageParams> {
  return {
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
        redirect: "follow",
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
    .describe("Optional HTTP headers to include in the request")
    .optional(),
});

function createFetchJson(fetchFn = globalThis.fetch): ToolDef<typeof fetchJsonParams> {
  return {
    description:
      "Call a REST API endpoint via HTTP GET and return the JSON response. Use this to fetch structured data from APIs — for example, weather data, stock prices, exchange rates, or any public JSON API. Supports custom headers for authenticated APIs.",
    parameters: fetchJsonParams,
    async execute(args, _ctx) {
      const { url, headers } = args;
      const resp = await fetchFn(url, {
        ...(headers && { headers }),
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
        await Promise.race([
          fn(fakeConsole),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Code execution timed out")), RUN_CODE_TIMEOUT),
          ),
        ]);
        const result = output.join("\n").trim();
        return result || "Code ran successfully (no output)";
      } catch (err: unknown) {
        return { error: errorMessage(err) };
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
  /** Override fetch implementation (defaults to globalThis.fetch). For testing. */
  fetch?: typeof globalThis.fetch;
};

type ToolDefRecord = Record<string, ToolDef<z.ZodObject<z.ZodRawShape>>>;

/** Single-tool creators and multi-tool expanders in one registry. */
const TOOL_REGISTRY: Record<
  string,
  { create: (opts?: BuiltinToolOptions) => ToolDef } | { multi: () => Record<string, ToolDef> }
> = {
  web_search: { create: (opts) => createWebSearch(opts?.fetch) },
  visit_webpage: { create: (opts) => createVisitWebpage(opts?.fetch) },
  fetch_json: { create: (opts) => createFetchJson(opts?.fetch) },
  run_code: { create: createRunCode },
  vector_search: { create: (opts) => createVectorSearch(opts?.vectorSearch ?? (async () => "")) },
  memory: { multi: memoryTools },
};

/** Resolve a builtin name to an array of [toolName, ToolDef] pairs. */
function resolveBuiltin(name: string, opts?: BuiltinToolOptions): [string, ToolDef][] {
  const entry = TOOL_REGISTRY[name];
  if (!entry) return [];
  if ("multi" in entry) return Object.entries(entry.multi());
  if (name === "vector_search" && !opts?.vectorSearch) return [];
  return [[name, entry.create(opts)]];
}

/**
 * Create built-in tool definitions for the given tool names.
 * For runtime use — vector_search requires opts.vectorSearch to be included.
 */
export function getBuiltinToolDefs(
  names: readonly string[],
  opts?: BuiltinToolOptions,
): ToolDefRecord {
  const defs: ToolDefRecord = {};
  for (const name of names) {
    for (const [k, v] of resolveBuiltin(name, opts)) defs[k] = v;
  }
  return defs;
}

/** Returns JSON tool schemas for the specified builtin tools. */
export function getBuiltinToolSchemas(names: readonly string[]): ToolSchema[] {
  return names.flatMap((name) =>
    resolveBuiltin(name, { vectorSearch: async () => "" }).map(([toolName, def]) => ({
      name: toolName,
      description: def.description,
      parameters: z.toJSONSchema(def.parameters ?? EMPTY_PARAMS) as ToolSchema["parameters"],
    })),
  );
}

// ─── Memory tools ──────────────────────────────────────────────────────────

/**
 * Returns a standard set of KV-backed memory tools: `save_memory`,
 * `recall_memory`, `list_memories`, and `forget_memory`.
 *
 * Spread the result into your agent's `tools` record.
 *
 * @example
 * ```ts
 * import { defineAgent, memoryTools } from "aai";
 *
 * export default defineAgent({
 *   name: "My Agent",
 *   tools: { ...memoryTools() },
 * });
 * ```
 */
export function memoryTools() {
  return {
    save_memory: tool({
      description:
        "Save a piece of information to persistent memory. Use a descriptive key like 'user:name' or 'project:status'.",
      parameters: z.object({
        key: z
          .string()
          .describe("A descriptive key for this memory (e.g. 'user:name', 'preference:color')"),
        value: z.string().describe("The information to remember"),
      }),
      execute: async ({ key, value }, ctx) => {
        await ctx.kv.set(key, value);
        return { saved: key };
      },
    }),
    recall_memory: tool({
      description: "Retrieve a previously saved memory by its key.",
      parameters: z.object({
        key: z.string().describe("The key to look up"),
      }),
      execute: async ({ key }, ctx) => {
        const value = await ctx.kv.get(key);
        if (value === null) return { found: false, key };
        return { found: true, key, value };
      },
    }),
    list_memories: tool({
      description: "List all saved memory keys, optionally filtered by a prefix (e.g. 'user:').",
      parameters: z.object({
        prefix: z
          .string()
          .describe("Prefix to filter keys (e.g. 'user:'). Use empty string for all.")
          .optional(),
      }),
      execute: async ({ prefix }, ctx) => {
        const entries = await ctx.kv.list(prefix ?? "");
        return { count: entries.length, keys: entries.map((e) => e.key) };
      },
    }),
    forget_memory: tool({
      description: "Delete a previously saved memory by its key.",
      parameters: z.object({
        key: z.string().describe("The key to delete"),
      }),
      execute: async ({ key }, ctx) => {
        await ctx.kv.delete(key);
        return { deleted: key };
      },
    }),
  };
}
