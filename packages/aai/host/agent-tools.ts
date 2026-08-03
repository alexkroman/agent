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
 *
 * Two shapes of every call, and a permissive return type, both for the same
 * reason: the first version of this module took only positional arguments
 * and returned `Promise<unknown>`, and in the very next eval EVERY call site
 * had to cast — `const data: any = await fetchJson(url)`,
 * `(await webSearch(query)) as any[]`. That is the mistake `useToolResult`
 * and `ToolCallInfo.args` had already been fixed for, reintroduced in a new
 * API hours later. A remote JSON body is not knowable by the framework, so
 * `unknown` buys no safety here — it only makes correct code fail to compile.
 * Pass a type argument (`fetchJson<Quote>(url)`) for real checking.
 *
 * The object form exists because agents reach for the shape they already
 * know from the model-facing builtin (`{ query, max_results }`), and guessing
 * wrong cost a build round.
 *
 * @module tools
 */

import type { DefaultToolResult } from "../sdk/types.ts";
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
export async function fetchJson<T = DefaultToolResult>(
  url: string | ({ url: string; headers?: Record<string, string> } & CallOptions),
  options?: { headers?: Record<string, string> } & CallOptions,
): Promise<T> {
  const spec = typeof url === "string" ? { url, ...options } : url;
  return (await callBuiltin(
    "fetch_json",
    { url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) },
    spec,
  )) as T;
}

/** Fetch a page and return its content as clean text. */
export async function visitWebpage<T = DefaultToolResult>(
  url: string | ({ url: string } & CallOptions),
  options?: CallOptions,
): Promise<T> {
  const spec = typeof url === "string" ? { url, ...options } : url;
  return (await callBuiltin("visit_webpage", { url: spec.url }, spec)) as T;
}

/** Search the web (DuckDuckGo-backed, no API key) and return ranked results. */
export async function webSearch<T = DefaultToolResult>(
  query: string | ({ query: string; max_results?: number; maxResults?: number } & CallOptions),
  options?: { maxResults?: number } & CallOptions,
): Promise<T> {
  const spec = typeof query === "string" ? { query, ...options } : query;
  // `max_results` is the builtin's spelling and `maxResults` the JS one;
  // both arrive here because both are things an author reasonably writes.
  const max = spec.max_results ?? spec.maxResults;
  return (await callBuiltin(
    "web_search",
    { query: spec.query, ...(max === undefined ? {} : { max_results: max }) },
    spec,
  )) as T;
}
