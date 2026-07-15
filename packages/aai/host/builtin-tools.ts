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
import { EMPTY_PARAMS, type ToolSchema, toToolJsonSchema } from "../sdk/_internal-types.ts";
import { FETCH_TIMEOUT_MS, MAX_HTML_BYTES, MAX_PAGE_CHARS } from "../sdk/constants.ts";
import type { ToolDef } from "../sdk/types.ts";

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
      const html = await resp.text();
      const text = htmlToText(html.slice(0, MAX_HTML_BYTES));
      const truncated = text.length > MAX_PAGE_CHARS;
      return {
        url,
        content: text.slice(0, MAX_PAGE_CHARS),
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

// ─── run_code ────────────────────────────────────────────────────────────────

const runCodeParams = z.object({
  code: z.string().describe("JavaScript code to execute. Use console.log() for output."),
});

/**
 * The run_code tool definition (schema + guidance only).
 *
 * run_code executes untrusted JavaScript and is ONLY ever run inside the guest
 * sandbox (gVisor/Deno): in platform mode the runtime delegates it over RPC to
 * `deno-harness`, which runs it there. This host-side `execute` is a guard for
 * the self-hosted path (`aai dev`), which has no sandbox — it refuses rather
 * than evaluating attacker-influenceable code in the host process. (The old
 * `node:vm` host execution was removed: `node:vm` is not a security boundary
 * and its `Function`-constructor escape leaked the host process.)
 */
function createRunCode(): ToolDef<typeof runCodeParams> & { guidance: string } {
  return {
    guidance:
      "You MUST use the run_code tool for ANY question involving math, counting, calculations, " +
      "data processing, or code. NEVER do mental math or recite code verbally. " +
      "run_code executes JavaScript (not Python). Always write JavaScript.",
    description:
      "Execute JavaScript code in a sandbox and return the output. Use this for calculations, data transformations, string manipulation, or any task that benefits from running code. Output is captured from console.log(). No network or filesystem access.",
    parameters: runCodeParams,
    async execute() {
      return {
        error:
          "run_code is only available in the sandboxed runtime and cannot run in this environment.",
      };
    },
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Options for creating built-in tool definitions. */
type BuiltinToolOptions = {
  /** Override fetch implementation (defaults to globalThis.fetch). For testing. */
  fetch?: typeof globalThis.fetch;
};

type ToolDefRecord = Record<string, ToolDef<z.ZodObject<z.ZodRawShape>>>;

/**
 * Builtins that execute untrusted code and must ONLY run inside the guest
 * sandbox (gVisor/Deno), never on the host. The runtime's sandbox-mode
 * dispatcher consults this to delegate them over RPC like custom tools.
 */
export const SANDBOX_ONLY_BUILTINS: ReadonlySet<string> = new Set(["run_code"]);

function resolveBuiltin(
  name: string,
  opts?: BuiltinToolOptions,
): (ToolDef & { guidance?: string }) | undefined {
  switch (name) {
    case "web_search":
      return createWebSearch(opts?.fetch);
    case "visit_webpage":
      return createVisitWebpage(opts?.fetch);
    case "fetch_json":
      return createFetchJson(opts?.fetch);
    case "run_code":
      return createRunCode();
    default:
      return;
  }
}

/** Resolved builtins with defs, schemas, and guidance computed in a single pass. */
type ResolvedBuiltins = {
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
    const def = resolveBuiltin(name, opts);
    if (!def) continue;
    defs[name] = def;
    schemas.push({
      type: "function",
      name,
      description: def.description,
      parameters: toToolJsonSchema(def.parameters ?? EMPTY_PARAMS) as ToolSchema["parameters"],
    });
    if (def.guidance) guidance.push(def.guidance);
  }

  return { defs, schemas, guidance };
}
