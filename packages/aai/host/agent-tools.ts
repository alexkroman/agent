// Copyright 2026 the AAI authors. MIT license.
/**
 * The network builtins, callable from your own tool code.
 *
 * `web_search`, `visit_webpage` and `fetch_json` are MODEL-facing: they are
 * declared to the LLM and the LLM calls them. Nothing exposed them to the
 * `execute` body of a tool the author wrote — and authors kept reaching for
 * them anyway. Across the starter evals, nine separate runs wrote
 * `ctx.fetch_json(...)`, `ctx.run_code(...)` or
 * `import { fetch_json } from "@alexkroman1/aai"`, most at several call
 * sites, and each one cost a build round.
 *
 * That is not a misunderstanding worth correcting with documentation. Someone
 * writing a tool that needs a REST call reasonably expects the framework's
 * REST call to be reachable; "which side of the model boundary does this live
 * on" is framework internals, and the author should not have to hold it. So
 * the capability is exposed rather than the rule restated.
 *
 * These are the SAME implementations the builtins use, reached through the
 * same factories — so URL screening, redirect re-validation, credential-header
 * stripping, response-size caps and timeouts all apply identically. Whether
 * the URL is screened at all is `builtinFetch`'s decision, not one made here:
 * inside a container it is plain `pinnedFetch` (the container is the
 * boundary, and tool code has open egress anyway), and on a developer's own
 * machine under `aai dev` it is `safeFetch`, because there the host IS
 * someone's laptop.
 *
 * `run_code` is deliberately NOT here. It exists to run code the MODEL wrote;
 * tool code that wants to compute something can just compute it.
 */

import { resolveBuiltin } from "./builtin-tools.ts";

/** The builtins carry a Zod schema, but a direct caller has typed arguments. */
type BuiltinArgs = Record<string, unknown>;

/**
 * `fetch` is for TESTS, and callers must leave it unset — same rule as
 * `safeFetch`'s. Naming an implementation is how you accidentally opt out of
 * the screening this whole module exists to keep.
 */
export type CallOptions = { fetch?: typeof globalThis.fetch };

async function callBuiltin(
  name: "web_search" | "visit_webpage" | "fetch_json",
  args: BuiltinArgs,
  options?: CallOptions,
) {
  const def = resolveBuiltin(name, options?.fetch ? { fetch: options.fetch } : undefined);
  if (!def?.execute) throw new Error(`Builtin "${name}" is unavailable`);
  // `ctx` is unused by all three — they close over their fetch — so the cast
  // keeps callers from having to synthesize a ToolContext they do not have.
  return await def.execute(args as never, undefined as never);
}

/**
 * GET a URL and return its parsed JSON.
 *
 * Returns `{ error, url }` rather than throwing on an HTTP failure or an
 * oversized body, matching what the model-facing builtin returns — a tool
 * that hands the result straight back to the model then says something useful
 * instead of failing the turn.
 */
export async function fetchJson(
  url: string,
  options?: { headers?: Record<string, string> } & CallOptions,
): Promise<unknown> {
  return await callBuiltin(
    "fetch_json",
    { url, ...(options?.headers ? { headers: options.headers } : {}) },
    options,
  );
}

/** Fetch a page and return its content as clean text. */
export async function visitWebpage(url: string, options?: CallOptions): Promise<unknown> {
  return await callBuiltin("visit_webpage", { url }, options);
}

/** Search the web (DuckDuckGo-backed, no API key) and return ranked results. */
export async function webSearch(
  query: string,
  options?: { maxResults?: number } & CallOptions,
): Promise<unknown> {
  return await callBuiltin(
    "web_search",
    { query, ...(options?.maxResults === undefined ? {} : { max_results: options.maxResults }) },
    options,
  );
}
