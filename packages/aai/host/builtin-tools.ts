// Copyright 2025 the AAI authors. MIT license.
/**
 * Built-in tool definitions for the AAI agent SDK.
 *
 * In self-hosted mode, these run in-process alongside custom tools.
 * In platform mode, they run on the host process outside the sandbox.
 *
 * The network-capable builtins (`web_search`, `visit_webpage`,
 * `get_page_design`, `fetch_json`)
 * take a fully model-controlled URL, so they default to {@link builtinFetch} —
 * SSRF-screened unless a spawner has declared a real container around us —
 * SSRF-protected by construction. Callers may inject a different `fetch` for
 * tests, but omitting it can no longer silently yield an unprotected
 * `globalThis.fetch`: that default previously left the self-hosted path
 * (`aai dev`) able to reach loopback, RFC 1918, and cloud-metadata addresses
 * with the response returned to whoever was driving the session.
 */

import { convert } from "html-to-text";
import { z } from "zod";
import { EMPTY_PARAMS, type ToolSchema, toToolJsonSchema } from "../sdk/_internal-types.ts";
import {
  FETCH_TIMEOUT_MS,
  MAX_HTML_BYTES,
  MAX_JSON_BYTES,
  MAX_PAGE_CHARS,
} from "../sdk/constants.ts";
import type { ToolDef } from "../sdk/types.ts";
import { calculate } from "./_calculate.ts";
import { createRunCode, type RunCodeExecutor } from "./builtin-run-code.ts";
import { createGetPageDesign } from "./page-design.ts";
import { readNotes, writeNote } from "./session-notes.ts";
import { builtinFetch } from "./ssrf.ts";

const fetchSignal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

const htmlToText = (html: string): string => convert(html, { wordwrap: false });

// ─── web_search ────────────────────────────────────────────────────────────
//
// Backed by DuckDuckGo's HTML endpoint — keyless, so every agent (and the
// studio's coding agent) gets search without provisioning a search-API
// credential. The scraping approach (endpoint, result/snippet selectors,
// uddg redirect decoding, bot-challenge detection) is ported from openclaw's
// duckduckgo web-search plugin (MIT, https://github.com/openclaw/openclaw —
// extensions/duckduckgo/src/ddg-client.ts). This replaced the Brave Search
// API implementation, which required a per-tenant BRAVE_API_KEY.

const webSearchParams = z.object({
  query: z.string().describe("The search query"),
  max_results: z.number().describe("Maximum number of results to return (default 5)").optional(),
});

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html";
/** DDG serves a stripped page to obvious bots; a browser UA gets results. */
const DDG_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
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

/** No results markup + challenge markers = we're being asked to prove humanity. */
function isBotChallenge(html: string): boolean {
  if (/class="[^"]*\bresult__a\b[^"]*"/i.test(html)) return false;
  return /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html);
}

type SearchResult = { title: string; url: string; description: string };

function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const resultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
  const nextResultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*>/i;
  const snippetRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i;

  for (const match of html.matchAll(resultRegex)) {
    const rawUrl = /\bhref="([^"]*)"/i.exec(match[1] ?? "")?.[1] ?? "";
    // The snippet anchor sits between this result link and the next one.
    const trailing = html.slice((match.index ?? 0) + match[0].length);
    const nextAt = trailing.search(nextResultRegex);
    const scoped = nextAt >= 0 ? trailing.slice(0, nextAt) : trailing;
    const title = decodeHtmlEntities(stripHtml(match[2] ?? ""));
    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl));
    const description = decodeHtmlEntities(stripHtml(snippetRegex.exec(scoped)?.[1] ?? ""));
    if (title && url) results.push({ title, url, description });
  }
  return results;
}

function createWebSearch(
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
      const url = `${DDG_HTML_ENDPOINT}?${new URLSearchParams({ q: query })}`;
      const resp = await fetchFn(url, {
        headers: { "User-Agent": DDG_USER_AGENT },
        signal: fetchSignal(),
      });
      if (!resp.ok) {
        return { error: `Search request failed: ${resp.status} ${resp.statusText}` };
      }
      const html = await resp.text();
      if (isBotChallenge(html)) {
        return { error: "Search provider returned a bot-detection challenge — try again later" };
      }
      return parseDuckDuckGoHtml(html).slice(0, count);
    },
  };
}

// ─── visit_webpage ─────────────────────────────────────────────────────────

const visitWebpageParams = z.object({
  url: z.string().describe("The full URL to fetch (e.g., 'https://example.com/page')"),
});

function createVisitWebpage(
  fetchFn = builtinFetch(),
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
  fetchFn = builtinFetch(),
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
      if (!resp.ok) return { error: `HTTP ${resp.status} ${resp.statusText}`, url };
      // Cap the body — a prompt-injected URL could otherwise make resp.json()
      // buffer an unbounded response (visit_webpage slices to MAX_HTML_BYTES).
      const max = MAX_JSON_BYTES;
      const declared = Number(resp.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > max) return { error: "Response too large", url };
      const body = await resp.text();
      if (body.length > max) return { error: "Response too large", url };
      try {
        return JSON.parse(body);
      } catch {
        return { error: "Response was not valid JSON", url };
      }
    },
  };
}

// ─── think ───────────────────────────────────────────────────────────────
//
// A private no-op scratchpad, verbatim from the spec Anthropic published for
// its tau-bench evaluation ("The 'think' tool", Mar 2025): the tool does
// nothing — the value is the designated reasoning step the model takes
// before acting. Tool-call-only steps emit no TTS in pipeline mode, so
// thoughts are silent on a voice call.

const thinkParams = z.object({
  thought: z.string().describe("A thought to think about."),
});

function createThink(): ToolDef<typeof thinkParams> & { guidance: string } {
  return {
    guidance:
      "Before any write action, and after any tool result that is unexpected or an error, " +
      "use the think tool as a private scratchpad: list the specific policy rules that apply, " +
      "check that you have every required argument, and verify the planned action complies. " +
      "Thoughts are never shown or spoken to the customer.",
    description:
      "Use the tool to think about something. It will not obtain new information or change the " +
      "database, but just append the thought to the log. Use it when complex reasoning or some " +
      "cache memory is needed.",
    parameters: thinkParams,
    execute() {
      return "ok";
    },
  };
}

// ─── remember / recall ──────────────────────────────────────────────────────
//
// Session-scoped notes; the store lives in session-notes.ts.

const rememberParams = z.object({
  key: z
    .string()
    .min(1)
    .describe('Short snake_case label for the fact (e.g. "user_id", "reservation_code")'),
  value: z.string().describe("The exact value to store, verbatim"),
});

function createRemember(): ToolDef<typeof rememberParams> & { guidance: string } {
  return {
    guidance:
      "The moment a tool result or the customer confirms an important value (an ID, code, " +
      "name, or date), save it with remember. Before using such a value in a later tool call, " +
      "recall it instead of retyping it from the conversation.",
    description:
      "Save a confirmed fact to private session notes under a short key (e.g. user_id, " +
      "order_id, reservation_code). Overwrites any previous value for that key and returns all " +
      "notes. Use it right after a value is confirmed, so later steps can recall the exact " +
      "value instead of re-reading a noisy transcript.",
    parameters: rememberParams,
    execute(args, ctx) {
      const notes = writeNote(ctx.sessionId, args.key, args.value);
      return { saved: args.key, notes: { ...notes } };
    },
  };
}

const recallParams = z.object({
  key: z.string().min(1).describe("The note key to read. Omit to list all notes.").optional(),
});

function createRecall(): ToolDef<typeof recallParams> & { guidance: string } {
  return {
    description:
      "Read private session notes saved with remember. Pass a key to get one value, or no key " +
      "to list every saved note. Notes are per-session and never shown to the customer.",
    guidance: "",
    parameters: recallParams,
    execute(args, ctx) {
      const notes = readNotes(ctx);
      if (args.key !== undefined) return { key: args.key, value: notes[args.key] ?? null };
      return { notes: { ...notes } };
    },
  };
}

// ─── calculate ──────────────────────────────────────────────────────────────

const calculateParams = z.object({
  expression: z
    .string()
    .describe('Arithmetic expression to evaluate, e.g. "(120.50 + 35) * 0.925"'),
});

function createCalculate(): ToolDef<typeof calculateParams> & { guidance: string } {
  return {
    guidance:
      "Use calculate for ALL arithmetic — totals, differences, fees, percentages, refund " +
      "amounts. Never compute numbers in your head.",
    description:
      "Evaluate an arithmetic expression and return the exact numeric result. Supports + - * " +
      "/ % (remainder), ^ (power), parentheses, unary minus, and decimal numbers (currency " +
      "symbols and commas are ignored). Use for ALL math: totals, differences, taxes, refunds.",
    parameters: calculateParams,
    execute(args) {
      const result = calculate(args.expression);
      if (!result.ok) return { error: result.error, expression: args.expression };
      return { expression: args.expression, result: result.value };
    },
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Options for creating built-in tool definitions. */
type BuiltinToolOptions = {
  /**
   * Override the fetch implementation. Defaults to the SSRF-protected
   * {@link builtinFetch} — override only in tests.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * In-sandbox run_code executor. Only the guest harness provides one —
   * without it, run_code refuses to evaluate code in this process.
   */
  runCode?: RunCodeExecutor;
};

type ToolDefRecord = Record<string, ToolDef<z.ZodObject<z.ZodRawShape>>>;

/**
 * Builtins that execute untrusted code and must ONLY run inside the guest
 * sandbox (Modal/Deno), never on the host. The runtime's sandbox-mode
 * dispatcher consults this to delegate them over RPC like custom tools.
 */
export const SANDBOX_ONLY_BUILTINS: ReadonlySet<string> = new Set(["run_code"]);

/**
 * Builtins whose definition depends on the injected `fetch` (the platform
 * supplies an SSRF-safe one), so they must be built per resolve.
 */
const FETCH_BUILTINS: Record<
  string,
  (fetchImpl?: typeof globalThis.fetch) => ToolDef & { guidance?: string }
> = {
  web_search: createWebSearch,
  visit_webpage: createVisitWebpage,
  get_page_design: (fetchImpl = builtinFetch()) => createGetPageDesign(fetchImpl),
  fetch_json: createFetchJson,
};

/**
 * Builtins with no injected dependencies. These were zero-argument factories
 * returning the same literal on every call — i.e. constants — so they are built
 * once at module load and the lookup replaces the dispatch switch.
 */
const STATIC_BUILTINS: Record<string, ToolDef & { guidance?: string }> = {
  think: createThink(),
  remember: createRemember(),
  recall: createRecall(),
  calculate: createCalculate(),
};

export function resolveBuiltin(
  name: string,
  opts?: BuiltinToolOptions,
): (ToolDef & { guidance?: string }) | undefined {
  if (name === "run_code") return createRunCode(opts?.runCode) as ToolDef & { guidance?: string };
  return FETCH_BUILTINS[name]?.(opts?.fetch) ?? STATIC_BUILTINS[name];
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
