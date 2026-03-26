// Copyright 2025 the AAI authors. MIT license.
/**
 * Built-in tool definitions for the AAI agent SDK.
 *
 * These tools run inside the sandboxed worker alongside custom tools.
 * Network requests go through the host's fetch proxy (with SSRF protection).
 */

import { convert } from "html-to-text";
import { z } from "zod";
import { EMPTY_PARAMS, type ToolSchema } from "./internal-types.ts";
import { memoryTools } from "./memory-tools.ts";
import type { ToolDef } from "./types.ts";
import { errorMessage } from "./utils.ts";

export { memoryTools } from "./memory-tools.ts";

/** Per-fetch timeout for network tools — tighter than the overall tool timeout. */
const FETCH_TIMEOUT_MS = 15_000;

/** Timeout for sandboxed code execution. */
const RUN_CODE_TIMEOUT = 5000;

const fetchSignal = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

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
      if (!resp.ok) {
        return { error: `Search request failed: ${resp.status} ${resp.statusText}` };
      }
      let raw: unknown;
      try {
        raw = await resp.json();
      } catch {
        return { error: "Response was not valid JSON" };
      }
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

/** Memory limit for run_code isolates (MB). */
const RUN_CODE_MEMORY_MB = 32;

/**
 * Execute JavaScript code inside a fresh secure-exec V8 isolate.
 *
 * Each invocation spins up a disposable isolate with:
 * - No filesystem writes
 * - No network access
 * - No child process spawning
 * - No environment variable access
 * - 32 MB memory limit
 * - 5 second execution timeout
 *
 * The isolate is disposed immediately after execution, so no state
 * leaks between invocations or across sessions.
 */
function createRunCode(): ToolDef<typeof runCodeParams> {
  return {
    description:
      "Execute JavaScript code in a secure sandbox and return the output. Use this for calculations, data transformations, string manipulation, or any task that benefits from running code. Output is captured from console.log(). No network or filesystem access.",
    parameters: runCodeParams,
    async execute(args) {
      return executeInIsolate(args.code);
    },
  };
}

/** Lazily import secure-exec to avoid top-level side effects. */
let _secureExec: typeof import("secure-exec") | undefined;
async function getSecureExec() {
  if (!_secureExec) _secureExec = await import("secure-exec");
  return _secureExec;
}

// The harness loads user code via readFileSync + AsyncFunction so that syntax
// errors are caught by try/catch rather than causing a silent module-parse failure.
const RUN_CODE_HARNESS = `
import { readFileSync } from "node:fs";

const __output = [];
const __capture = (...args) => __output.push(args.map(String).join(" "));
const __console = {
  log: __capture, info: __capture, warn: __capture,
  error: __capture, debug: __capture,
};
try {
  const __userCode = readFileSync("/app/user-code.js", "utf8");
  const __AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
  const __fn = new __AsyncFn("console", __userCode);
  await __fn(__console);
  const result = __output.join("\\n").trim();
  process.stdout.write(JSON.stringify({ ok: true, result: result || "Code ran successfully (no output)" }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
}
`;

const READ_ONLY_FS_OPS = new Set(["read", "stat", "readdir", "exists"]);

/** Parse stdout from the run_code harness into a result or error. */
function parseIsolateOutput(stdout: string, stderr: string): string | { error: string } {
  if (!stdout) {
    if (stderr) return { error: stderr.trim() };
    return { error: "Code execution timed out" };
  }
  try {
    const parsed = JSON.parse(stdout) as { ok: boolean; result?: string; error?: string };
    if (parsed.ok) return parsed.result ?? "Code ran successfully (no output)";
    return { error: parsed.error ?? "Unknown error" };
  } catch {
    return stdout.trim() || "Code ran successfully (no output)";
  }
}

/**
 * Exported for testing — execute user code in a fresh secure-exec V8 isolate.
 */
export async function executeInIsolate(code: string): Promise<string | { error: string }> {
  const {
    createInMemoryFileSystem,
    createNodeDriver,
    createNodeRuntimeDriverFactory,
    NodeRuntime,
  } = await getSecureExec();

  const fs = createInMemoryFileSystem();
  await fs.writeFile("/app/harness.js", RUN_CODE_HARNESS);
  await fs.writeFile("/app/user-code.js", code);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let finished = false;

  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: fs,
      permissions: {
        fs: (req) =>
          READ_ONLY_FS_OPS.has(req.op)
            ? { allow: true }
            : { allow: false, reason: "Filesystem is read-only" },
        network: () => ({ allow: false, reason: "Network access is disabled in run_code" }),
        childProcess: () => ({ allow: false, reason: "Subprocess spawning is disabled" }),
        env: () => ({ allow: false, reason: "Env access is disabled in run_code" }),
      },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: RUN_CODE_MEMORY_MB,
    onStdio(event) {
      if (event.channel === "stdout") stdoutChunks.push(event.message);
      if (event.channel === "stderr") {
        stderrChunks.push(event.message);
        // Stderr output (e.g. uncaught errors, syntax errors) means
        // the isolate is done — no stdout result will follow.
        finished = true;
      }
    },
  });

  // Await the exec promise so the isolate completes naturally before disposal.
  // This avoids "Isolate is disposed" rejections from internal secure-exec
  // promises (like ESM compilation) that fire when we dispose mid-execution.
  const execPromise = runtime.exec('import "/app/harness.js";', { cwd: "/app" });

  try {
    const deadline = Date.now() + RUN_CODE_TIMEOUT;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      if (stdoutChunks.length > 0 || finished) break;
    }

    // Let the isolate finish naturally — wait a short grace period for exec
    // to settle after output is captured (avoids disposing mid-execution).
    await Promise.race([
      execPromise.catch(() => {
        // exec may reject on error code paths — already handled by parseIsolateOutput
      }),
      new Promise((r) => setTimeout(r, 200)),
    ]);

    return parseIsolateOutput(stdoutChunks.join(""), stderrChunks.join(""));
  } catch (err: unknown) {
    return { error: errorMessage(err) };
  } finally {
    runtime.dispose();
  }
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
