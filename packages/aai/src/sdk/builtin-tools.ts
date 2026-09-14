// Copyright 2026 the AAI authors. MIT license.
/**
 * The built-in tool vocabulary — the names `agent({ builtinTools })` accepts.
 *
 * Split out of `types.ts` when that file reached the 500-line cap; the seam is
 * the natural one, since nothing else in that module is about what runs on the
 * HOST rather than in the agent's own `tools/` directory. `types.ts` re-exports
 * the name, so an import of it is unchanged.
 */

/**
 * Identifier for a built-in server-side tool.
 *
 * Built-in tools run on the host process (not inside the sandboxed worker)
 * and provide capabilities like web search, code execution, and API access.
 *
 * - `"web_search"` — Search the web for current information, facts, or news.
 * - `"visit_webpage"` — Fetch a URL and return its content as clean text.
 * - `"get_page_design"` — Fetch a URL's raw HTML and CSS (markup, style blocks,
 *   linked stylesheets) to study or mimic a site's visual design.
 * - `"fetch_json"` — Call a REST API endpoint and return the JSON response.
 * - `"run_code"` — Execute JavaScript in a sandbox for calculations and data processing.
 * - `"think"` — Private no-op scratchpad for policy checks and planning (never spoken).
 * - `"remember"` — Save a confirmed fact (ID, code, date) to private session notes.
 * - `"recall"` — Read back facts saved with `remember`.
 * - `"calculate"` — Safely evaluate an arithmetic expression (no code execution).
 *
 * When `builtinTools` is not set, NONE are enabled
 * (`DEFAULT_BUILTIN_TOOLS` is empty) — a built-in is something an agent
 * asks for rather than something it has to notice and switch off. Name the
 * ones you want; `[]` and omitting the field mean the same thing.
 *
 * @public
 */
export type BuiltinTool =
  | "web_search"
  | "visit_webpage"
  | "get_page_design"
  | "fetch_json"
  | "run_code"
  | "think"
  | "remember"
  | "recall"
  | "calculate";
