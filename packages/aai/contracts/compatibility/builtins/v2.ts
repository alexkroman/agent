// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:builtins` epoch 2.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative. Epoch 1 was DROPPED, and this is the shape that replaced it: the
 * three network builtins answer `T | ToolFailure`, so a caller that names a
 * shape narrows with {@link isToolFailure}.
 *
 * Epoch 1's example assigned the result straight to its type
 * (`const rates: Rates = await fetchJson<Rates>(url)`), which is what stopped
 * compiling. It was not a cosmetic break: a builtin's failure IS its result —
 * `{ error }` rather than a throw, because these are model-facing and a tool
 * should hand something useful back rather than fail the turn — and under
 * `Promise<T>` that was invisible. All three call sites in this repo read a field
 * with `?? []` or `?? ""`, so a live DuckDuckGo `403` arrived at the model as
 * "the web has nothing".
 *
 * Both call shapes and the loose-return decision are frozen here too, because
 * they are the epoch-1 promises that DID survive.
 */

import { fetchJson, visitWebpage, webSearch } from "../../../host/agent-tools.ts";
import { isToolFailure } from "../../../sdk/utils.ts";

type Rates = { usd: number };

/** The shape that replaced epoch 1's: name a type, then narrow. */
export async function rates(): Promise<Rates | null> {
  const answer = await fetchJson<Rates>("https://example.invalid/rates");
  // The failure is a legitimate answer, and a tool usually forwards it rather
  // than throwing — this one reports "no rates" to its caller.
  if (isToolFailure(answer)) return null;
  return answer;
}

/** The object form, with headers — still both shapes, still no cast. */
export async function ratesWithHeaders(token: string): Promise<Rates | { error: string }> {
  const answer = await fetchJson<Rates>({
    url: "https://example.invalid/rates",
    headers: { Authorization: `Bearer ${token}` },
  });
  // Forwarding it unchanged is the other legitimate move, which is why the guard
  // is a NARROWING one: the union is the tool's own return type here.
  return answer;
}

/** A page, where an unreadable one must not read as an empty one. */
export async function pageText(url: string): Promise<string> {
  const page = await visitWebpage<string>(url);
  if (isToolFailure(page)) return `Could not read that page: ${page.error}`;
  return page;
}

/** A search, and the case the epoch exists for. */
export async function firstResultTitles(query: string): Promise<string[]> {
  const found = await webSearch<{ results?: { title?: string }[] }>({ query, maxResults: 5 });
  // NOT `(found.results ?? [])` — that is the line this epoch was minted over.
  if (isToolFailure(found)) throw new Error(`Search refused: ${found.error}`);
  return (found.results ?? []).flatMap((one) => (one.title ? [one.title] : []));
}

/** An UNTYPED call stays loose, which is epoch 1's other surviving promise. */
export async function looseCall(query: string): Promise<unknown> {
  // `DefaultToolResult` is `any`, and `any | ToolFailure` is `any`, so reading a
  // field still compiles with no cast and no narrowing.
  const byString = await webSearch(query, { maxResults: 5 });
  const bySnakeCase = await webSearch({ query, max_results: 5 });
  return [byString.results, bySnakeCase.results];
}
