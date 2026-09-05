// Copyright 2026 the AAI authors. MIT license.
/**
 * The network builtins, callable from your own tool code.
 *
 * ## The three calls
 *
 * | Call | Answers |
 * | --- | --- |
 * | {@link fetchJson} | a JSON body from a URL |
 * | {@link visitWebpage} | a page, reduced to prose |
 * | {@link webSearch} | search results |
 *
 * Each takes positional arguments or the option object the model-facing builtin
 * declares, and each ANSWERS `T | ToolFailure` rather than throwing — so the
 * one thing to write is the narrowing:
 *
 * ```ts
 * import { fetchJson } from "@alexkroman1/aai/tools";
 * import { isToolFailure, type ToolFailure } from "@alexkroman1/aai/utils";
 *
 * export async function priceOf(url: string): Promise<number | ToolFailure> {
 *   const quote = await fetchJson<{ price: number }>(url);
 *   // Hand the model the failure rather than turning it into a wrong answer.
 *   if (isToolFailure(quote)) return quote;
 *   return quote.price;
 * }
 * ```
 *
 * Pass a type argument for real checking; the default keeps a field read
 * loose, which is what the untyped call sites need. No credential and no
 * setup: these are the SAME implementations the builtins use, so URL
 * screening, redirect re-validation, credential-header stripping,
 * response-size caps and timeouts all apply identically.
 *
 * `run_code` is deliberately NOT here. It exists to run code the MODEL wrote;
 * tool code that wants to compute something can just compute it.
 *
 * ## All three can ANSWER with a failure, and the type says so
 *
 * A builtin's failure IS its result — `{ error }` rather than a throw — because
 * these are model-facing and a tool that hands the result straight back to the
 * model should say something useful rather than fail the turn. That contract is
 * right and is not changing. What was wrong is that it was invisible: they were
 * typed `Promise<T>`, so a caller that named a shape got that shape and nothing
 * told it a failure was possible.
 *
 * **Every caller in this repo got it wrong, three for three**, and all three the
 * same way — `(results.results ?? [])` and `page.content ?? ""`, which turn a
 * real failure into an empty answer. Measured 2026-08-13: DuckDuckGo answered
 * `403` to both endpoints from this machine, so `research-workflow` and `plan-and-execute`
 * were both reporting "No results." for every search, with the 403 nowhere.
 * `research-workflow` even had a `catch` for it, carefully commented — and a `catch`
 * cannot see a returned value, so it never ran.
 *
 * So the return type is `T | ToolFailure` and `isToolFailure`
 * (`@alexkroman1/aai/utils`) is how a caller narrows it.
 *
 * **`T` therefore must not default to `any`.** It did — to
 * `DefaultToolResult` — and `any | ToolFailure` is `any`, so the union the
 * paragraph above exists for was erased for exactly the callers that never
 * named a shape, i.e. the three that shipped the bug. `const a = await
 * fetchJson(url); a.no.such.field` was zero errors.
 *
 * The default is `Record<string, DefaultToolResult>` instead — the shape
 * `ToolCallInfo.args` already uses, and the only one that keeps BOTH
 * properties. The union survives, so the first field read off an unnarrowed
 * result fails with `Property 'price' does not exist on type 'ToolFailure'`,
 * which names the thing that was forgotten; and past the narrowing a field is
 * `any` again, so a call site that never named a shape still compiles with no
 * cast. What it costs is a JSON body that is not an
 * object — a top-level array, a bare string — which needs the type argument
 * (`fetchJson<Item[]>(url)`) it should be naming anyway.
 *
 * @module tools
 */

import { invariant } from "../sdk/invariant.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { DefaultToolResult } from "../sdk/types.ts";
import type { ToolFailure } from "../sdk/utils.ts";
import { resolveBuiltin } from "./builtin-tools.ts";
import { builtinFetch } from "./ssrf.ts";

/** The builtins carry a Zod schema, but a direct caller has typed arguments. */
type BuiltinArgs = Record<string, unknown>;

/**
 * What an unparameterized call answers with — see the module doc for why this
 * rather than `DefaultToolResult` (which is `any`, and absorbs the
 * `| ToolFailure` the whole contract is carried by) or `unknown` (which
 * survives the narrowing and makes every read a cast).
 *
 * EXPORTED because it is the declared default of all three functions below, so
 * it is part of what a caller reads back and part of what they are overriding
 * when they pass a `T`. Left unexported it was a name in three public
 * signatures that resolved to nothing a reader could follow — which TypeDoc
 * reports as a warning and the docs build turns into a failure.
 */
export type UntypedJsonBody = Record<string, DefaultToolResult>;

export type CallOptions = {
  /**
   * For TESTS, and callers must leave it unset — same rule as `safeFetch`'s.
   * Naming an implementation is how you accidentally opt out of the screening
   * this whole module exists to keep.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Cancel the request — pass `ctx.signal`, which a tool always has.
   *
   * A page fetch and a search are the two slowest things a tool does and the
   * ones a barge-in most wants back, and without this the only way to abort one
   * was to abandon these wrappers for a raw `fetch` — i.e. to opt out of the
   * screening, the header stripping and the size caps at the same time. That is
   * the whole reason the option is here: the compliant path must not be the one
   * that gives up the safe fetch.
   *
   * An abort REJECTS (fetch's own `AbortError`) rather than answering
   * `{ error }`. The failure-as-a-result contract above is about telling the
   * MODEL something useful, and a cancelled turn has no model left to tell —
   * the tool's own `await` is being unwound. Same shape as the existing
   * per-request timeout, which has always thrown.
   */
  signal?: AbortSignal;
};

/**
 * The caller's signal, folded into whatever deadline the builtin already sets.
 *
 * Wrapping the FETCH is what keeps this out of `builtin-tools.ts`: the three
 * factories, `fetchCappedText` and the two search endpoints would each have to
 * thread a signal they have no other use for, and the model-facing side of all
 * of them has nothing to thread. `fetchCappedText` always sets its own
 * `FETCH_TIMEOUT_MS` deadline, so the combining arm is the one that actually
 * runs — whichever fires first wins, and `AbortSignal.any` holds its sources
 * weakly, so there is no unlink to forget.
 */
function withSignal(base: typeof globalThis.fetch, signal: AbortSignal): typeof globalThis.fetch {
  return (input, init) => {
    const own = init?.signal;
    return base(input, {
      ...init,
      signal: own ? AbortSignal.any([own, signal]) : signal,
    });
  };
}

/**
 * Fold the two shapes into one spec: `f(value, options)` and `f({ value, ...options })`.
 *
 * The three wrappers each wrote this line, and each wrote it the same wrong way
 * — `typeof x === "string" ? { key: x, ...options } : x` DROPS `options` in the
 * object form, so `fetchJson({ url }, { fetch })` silently ignored the fetch it
 * was handed. Merging both ways keeps the object form's own fields winning,
 * which is the reading that matches "the object IS the spec".
 */
function normalizeSpec<K extends string, S extends object>(
  key: K,
  value: string | S,
  options: object | undefined,
): S & Record<K, string> {
  return (
    typeof value === "string" ? { [key]: value, ...options } : { ...options, ...value }
  ) as S & Record<K, string>;
}

async function callBuiltin(
  name: "web_search" | "visit_webpage" | "fetch_json",
  args: BuiltinArgs,
  options?: CallOptions,
) {
  // `builtinFetch()` is named here only to have something to wrap, and it is
  // the same call the factory would have made — a pure read of `CONTAINED_ENV`
  // — so which fetch runs is unchanged. It is deliberately not
  // `globalThis.fetch`: defaulting to that would turn passing a signal into an
  // SSRF opt-out, which is the trade this option exists to remove.
  const signal = options?.signal;
  const fetchImpl = signal ? withSignal(options?.fetch ?? builtinFetch(), signal) : options?.fetch;
  const def = resolveBuiltin(name, fetchImpl ? { fetch: fetchImpl } : undefined);
  // `name` is one of three literals this module writes itself, and all three are
  // in `builtin-tools.ts`'s own fetch table with an `execute` — so a miss is that
  // table having lost an entry, never a caller naming a builtin that is gated off.
  invariant(def?.execute !== undefined, "builtin.callable", () => ({ name }));
  // `ctx` is unused by all three — they close over their fetch — so the cast
  // keeps callers from having to synthesize a ToolContext they do not have.
  return await def.execute(args as never, undefined as never);
}

/**
 * GET a URL and return its parsed JSON.
 *
 * Answers `{ error, url }` rather than throwing on an HTTP failure or an
 * oversized body, matching what the model-facing builtin returns. Narrow it with
 * `isToolFailure` — see the module doc for why the union is in the type.
 */
export async function fetchJson<T = UntypedJsonBody>(
  url: string | ({ url: string; headers?: Record<string, string> } & CallOptions),
  options?: { headers?: Record<string, string> } & CallOptions,
): Promise<T | ToolFailure> {
  const spec = normalizeSpec("url", url, options);
  return (await callBuiltin(
    "fetch_json",
    { url: spec.url, ...omitUndefined({ headers: spec.headers }) },
    spec,
  )) as T;
}

/**
 * Fetch a page and return its content as clean text.
 *
 * Answers `{ error }` for a page it could not read — narrow with
 * `isToolFailure`, and see the module doc for why.
 */
export async function visitWebpage<T = UntypedJsonBody>(
  url: string | ({ url: string } & CallOptions),
  options?: CallOptions,
): Promise<T | ToolFailure> {
  const spec = normalizeSpec("url", url, options);
  return (await callBuiltin("visit_webpage", { url: spec.url }, spec)) as T;
}

/**
 * Search the web (DuckDuckGo-backed, no API key) and return ranked results.
 *
 * Answers `{ error }` when both DuckDuckGo endpoints refuse — a `403` or a bot
 * challenge, which is a routine outcome rather than an edge case. Narrow with
 * `isToolFailure`: an unnarrowed `?? []` reads as "the web has nothing", which is
 * a different claim and the one this repo shipped twice.
 */
export async function webSearch<T = UntypedJsonBody>(
  query: string | ({ query: string; maxResults?: number } & CallOptions),
  options?: CallOptions,
): Promise<T | ToolFailure> {
  const spec = normalizeSpec("query", query, options);
  // ONE spelling in ONE position. It used to take `max_results` as well — the
  // only snake_case identifier on this SDK's TypeScript surface, and the only
  // option with two names — and `maxResults` in the second parameter too, so
  // one option had three ways to arrive. `max_results` stays the WIRE name
  // below because it is the builtin's own schema, which the model reads.
  const max = spec.maxResults;
  return (await callBuiltin(
    "web_search",
    { query: spec.query, ...omitUndefined({ max_results: max }) },
    spec,
  )) as T;
}
