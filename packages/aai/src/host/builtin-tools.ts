// Copyright 2025 the AAI authors. MIT license.
/**
 * Built-in tool definitions for the AAI agent SDK.
 *
 * In self-hosted mode, these run in-process alongside custom tools.
 * In platform mode, they run on the host process outside the sandbox.
 *
 * The network-capable builtins (`web_search`, `visit_webpage`,
 * `get_page_design`, `fetch_json`) take a fully model-controlled URL, so they
 * default to {@link builtinFetch}: SSRF-screened whenever no spawner has
 * declared a real container around us (`aai dev`, the subprocess backend);
 * inside a Modal container the screen is skipped because the sandbox itself is
 * the security boundary. Callers may inject a different `fetch` for tests, but
 * omitting it can no longer silently yield an unprotected `globalThis.fetch`:
 * that default previously left the self-hosted path (`aai dev`) able to reach
 * loopback, RFC 1918, and cloud-metadata addresses with the response returned
 * to whoever was driving the session.
 */

import { compile } from "html-to-text";
import { z } from "zod";
import { agentToolsToSchemas, type ToolSchema } from "../sdk/_internal-types.ts";
import { HTML_ACCEPT, MAX_HTML_BYTES, MAX_JSON_BYTES, MAX_PAGE_CHARS } from "../sdk/constants.ts";
import { toolset } from "../sdk/toolset.ts";
import type { ToolDef } from "../sdk/types.ts";
import { builtinCover } from "./_builtin-cover.ts";
import { calculate } from "./_calculate.ts";
import { fetchCappedJson, fetchCappedText } from "./_fetch-capped.ts";
import { createBraveSearch } from "./brave-search.ts";
import { createRunCode, type RunCodeExecutor } from "./builtin-run-code.ts";
import { createGooglePlaces } from "./google-places.ts";
import { createOpenMeteo } from "./open-meteo.ts";
import { createGetPageDesign } from "./page-design.ts";
import { readNotes, writeNote } from "./session-notes.ts";
import { builtinFetch } from "./ssrf.ts";
import { createTextMe } from "./text-me.ts";
import { createWebSearch } from "./web-search.ts";

// Compiled once: `convert()` rebuilds the selector index per call (116 µs vs
// 3.5 µs), and this runs on every `visit_webpage`.
const htmlToText = compile({ wordwrap: false });

// ─── web_search ────────────────────────────────────────────────────────────
//
// Lives in web-search.ts: DuckDuckGo scraping with a lite-endpoint fallback
// for the primary endpoint's bot-detection challenges.

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
    inputSchema: visitWebpageParams,
    messages: builtinCover("I'm reading the page."),
    async execute(args, _ctx) {
      const { url } = args;
      // Bounded at the READ — see `_fetch-capped.ts`. A page past the budget is
      // still worth the part we have, so the surplus is dropped silently and the
      // caller-facing truncation flag stays the MAX_PAGE_CHARS one below.
      const page = await fetchCappedText(url, {
        fetch: fetchFn,
        accept: HTML_ACCEPT,
        maxBytes: MAX_HTML_BYTES,
      });
      if (!page.ok) {
        return { error: `Failed to fetch: ${page.error}`, url };
      }
      const text = htmlToText(page.text);
      return {
        url,
        content: text.slice(0, MAX_PAGE_CHARS),
        ...(text.length > MAX_PAGE_CHARS ? { truncated: true, totalChars: text.length } : {}),
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
    inputSchema: fetchJsonParams,
    messages: builtinCover("I'm waiting on that service."),
    execute: (args, _ctx) => requestJson(fetchFn, args.url, { headers: args.headers }),
  };
}

/**
 * The `fetch_json` request, GET for the model and any method for a direct
 * `fetchJson` caller: headers screened, the body read under the byte cap,
 * every failure — HTTP, oversized, unparseable, and a network failure or SSRF
 * refusal too — answered as `{ error, url }`, never thrown.
 *
 * The read, the refusal of a clipped body and the parse are `fetchCappedJson`'s;
 * this adds only the header screen and the model-facing error shape. An HTTP
 * failure keeps its `HTTP ` prefix (`"HTTP 404 Not Found"`), told apart from
 * the other failures by the `status` only an HTTP failure carries.
 *
 * @internal
 */
export async function requestJson(
  fetchFn: typeof globalThis.fetch,
  url: string,
  init: { headers?: Record<string, string> | undefined; method?: string; body?: unknown } = {},
): Promise<unknown> {
  const hasBody = init.body !== undefined;
  // The URL is prompt-injectable, so the cap has to bound what is READ:
  // `fetchCappedJson` stops the body stream at MAX_JSON_BYTES rather than
  // buffering it whole and measuring afterwards, and refuses a clipped one.
  const json = await fetchCappedJson(url, {
    fetch: fetchFn,
    maxBytes: MAX_JSON_BYTES,
    headers: hasBody
      ? { "content-type": "application/json", ...sanitizeHeaders(init.headers) }
      : sanitizeHeaders(init.headers),
    body: hasBody ? JSON.stringify(init.body) : undefined,
    method: init.method?.toUpperCase(),
  });
  if (json.ok) return json.value;
  return { error: json.status === undefined ? json.error : `HTTP ${json.error}`, url };
}

// ─── think ───────────────────────────────────────────────────────────────
//
// A private no-op scratchpad, verbatim from the spec Anthropic published for
// its tau-bench evaluation ("The 'think' tool", Mar 2025): the tool does
// nothing — the value is the designated reasoning step the model takes
// before acting. Tool-call-only steps emit no TTS in pipeline mode, so
// thoughts are silent on a voice call.
//
// The guidance's "is present" sentence is ours, not the spec's: "check that
// you have every required argument" alone made the model judge an argument
// missing when an earlier result supplied it only as an id, or the caller had
// described it rather than spelled it out, and stop mid-chain. Offline replay:
// stop-mid-chain after think 7/90 pooled without the sentence, 1/30 with it;
// asks for a truly missing identifier were unchanged.

const thinkParams = z.object({
  thought: z.string().describe("A thought to think about."),
});

function createThink(): ToolDef<typeof thinkParams> & { guidance: string } {
  return {
    guidance:
      "Before any write action, and after any tool result that is unexpected or an error, " +
      "use the think tool as a private scratchpad: list the specific policy rules that apply, " +
      "check that you have every required argument, and verify the planned action complies. " +
      "An argument you can fill from the caller's own description or from an earlier tool " +
      "result (an id, a name, the item they pointed to) is present — pass that and let the " +
      "tool accept or reject it; never stop a requested step, or ask, just because a value is " +
      "less exact than you would like. " +
      "Thoughts are never shown or spoken to the customer.",
    description:
      "Use the tool to think about something. It will not obtain new information or change the " +
      "database, but just append the thought to the log. Use it when complex reasoning or some " +
      "cache memory is needed.",
    inputSchema: thinkParams,
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
    inputSchema: rememberParams,
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
    inputSchema: recallParams,
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
    inputSchema: calculateParams,
    execute(args) {
      const result = calculate(args.expression);
      if (!result.ok) return { error: result.error, expression: args.expression };
      return { expression: args.expression, result: result.value };
    },
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Options for creating built-in tool definitions. */
export type BuiltinToolOptions = {
  /**
   * Override the fetch implementation. Defaults to {@link builtinFetch}
   * (SSRF-screened outside a declared container) — override only in tests.
   *
   * @internal
   */
  fetch?: typeof globalThis.fetch;
  /**
   * In-sandbox run_code executor. Only the guest harness provides one —
   * without it, run_code refuses to evaluate code in this process.
   */
  runCode?: RunCodeExecutor;
};

/** Resolved builtin tool definitions, keyed by tool name. */
export type ToolDefRecord = Record<string, ToolDef>;

/**
 * Builtins built from the in-sandbox executor the guest harness supplies —
 * a third record of the same shape rather than a name compared by hand, which
 * is what made `run_code` the one builtin whose lookup needed a cast.
 */
const SANDBOX_BUILTINS: Record<
  string,
  (runCode?: RunCodeExecutor) => ToolDef & { guidance?: string }
> = {
  run_code: createRunCode,
};

/**
 * Builtins that execute untrusted code and must ONLY run inside the guest
 * sandbox (Modal/Deno), never on the host. The runtime's sandbox-mode
 * dispatcher consults this to delegate them over RPC like custom tools.
 *
 * DERIVED from the record above: the two would otherwise be one hand-kept list
 * each, and a sandbox builtin missing from this set runs on the host.
 *
 * @internal
 */
export const SANDBOX_ONLY_BUILTINS: ReadonlySet<string> = new Set(Object.keys(SANDBOX_BUILTINS));

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
  // Fixed-host API clients. Their URLs are ours, not the model's, but they take
  // the same screened fetch so every network builtin has one egress path — and
  // so a spec injects one double for all of them. Three read a key from the
  // agent env at call time; `open_meteo` is keyless.
  open_meteo: createOpenMeteo,
  brave_search: createBraveSearch,
  google_places: createGooglePlaces,
  text_me: createTextMe,
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

/**
 * Resolve one builtin tool by name; `undefined` for unknown names.
 *
 * **Membership is `Object.hasOwn`, not a truthy index.** These records are
 * object literals, so a plain `RECORD[name]` walks `Object.prototype` and
 * `resolveAllBuiltins(["constructor"])` reached `Object` — invoked as a factory,
 * it returns an object, which was then declared as a tool with no `execute`.
 * `["toString"]` was worse: it returned a STRING, and `agentToolsToSchemas`
 * crashes on `"parameters" in def` for a primitive. Only the untyped
 * `/runtime` API can pass such a name (the deploy schema is a `z.enum`), which
 * is why it stayed reachable.
 *
 * @internal
 */
export function resolveBuiltin(
  name: string,
  options?: BuiltinToolOptions,
): (ToolDef & { guidance?: string }) | undefined {
  if (Object.hasOwn(SANDBOX_BUILTINS, name)) return SANDBOX_BUILTINS[name]?.(options?.runCode);
  if (Object.hasOwn(FETCH_BUILTINS, name)) return FETCH_BUILTINS[name]?.(options?.fetch);
  if (Object.hasOwn(STATIC_BUILTINS, name)) return STATIC_BUILTINS[name];
  return undefined;
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
  options?: BuiltinToolOptions,
): ResolvedBuiltins {
  const defs: ToolDefRecord = {};
  const guidance: string[] = [];

  for (const name of names) {
    const def = resolveBuiltin(name, options);
    if (!def) continue;
    defs[name] = def;
    if (def.guidance) guidance.push(def.guidance);
  }

  // One tool→wire-schema mapping for builtins and agent tools alike.
  return { defs, schemas: agentToolsToSchemas([toolset("builtin", defs)]), guidance };
}
