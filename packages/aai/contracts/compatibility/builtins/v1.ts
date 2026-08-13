// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `builtins` epoch 1.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { type CallOptions, fetchJson, visitWebpage, webSearch } from "../../../host/agent-tools.ts";

type Rates = { rates: Record<string, number> };

/** The bare-string form, and the typed return. */
export async function rates(): Promise<Rates> {
  return await fetchJson<Rates>("https://example.invalid/rates");
}

/** The object form, with headers on the request rather than the options bag. */
export async function authorized(token: string): Promise<Rates> {
  return await fetchJson<Rates>({
    url: "https://example.invalid/rates",
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Headers supplied through the second argument instead. */
export async function withOptions(token: string): Promise<Rates> {
  return await fetchJson<Rates>("https://example.invalid/rates", {
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function readPage(url: string): Promise<string> {
  return await visitWebpage<string>(url);
}

export async function search(query: string): Promise<unknown> {
  const byString = await webSearch(query, { maxResults: 5 });
  const byObject = await webSearch({ query, maxResults: 5 });
  const snakeCase = await webSearch({ query, max_results: 5 });
  return [byString, byObject, snakeCase];
}

/**
 * The `fetch` override exists for tests. Production callers leave it unset so
 * the SSRF-screened default applies.
 */
export const testOptions: CallOptions = { fetch: globalThis.fetch };
