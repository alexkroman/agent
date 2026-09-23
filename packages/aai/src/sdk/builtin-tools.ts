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
 * When `builtinTools` is not set, only `think` is enabled
 * (`DEFAULT_BUILTIN_TOOLS`); every other built-in is something an agent asks
 * for by name. Setting the field replaces the default rather than extending
 * it — include `"think"` to keep it, and pass `[]` for no built-ins at all.
 *
 * OPEN, like `VoicePresetName`: the names above are written inline as the
 * autocomplete half, and any other string compiles, so an agent naming a
 * builtin a later release adds still builds against this one. The runtime
 * resolves only the names it ships and skips the rest, so an unknown name is a
 * tool that silently never appears — which is why `aai build` / `aai dev` warn
 * about it (`agentConfigWarnings`) rather than the type refusing it. Inline
 * rather than an exported closed `Known…` half, so a builtin added here is a
 * compatible change to this type.
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
  | "calculate"
  | (string & {});
