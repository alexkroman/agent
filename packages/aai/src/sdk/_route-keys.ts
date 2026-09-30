// Copyright 2026 the AAI authors. MIT license.
/**
 * The ROUTE-KEY vocabulary both fake networks share — `stubFetchRoutes`
 * (`@alexkroman1/aai/testing`) and `evalNetwork`
 * (`@alexkroman1/aai-runtime/eval`) — written once.
 *
 * The two had each implemented it: the same three key forms, the same
 * 2_000_000 / 1_000_000 specificity weights, the same "record a `Request`,
 * parse its body as JSON if it parses" preamble. A rule changed in one (a
 * method prefix, which only `stubFetchRoutes` had) was a rule the other did not
 * know, and "the key vocabulary `evalNetwork` uses" was a claim in a doc comment
 * that nothing held. The host runtime reaches this through
 * `@alexkroman1/aai/host-internal`.
 *
 * A KEY is an optional upper-case METHOD and whitespace, then one of:
 *
 * - a HOST — `"api.mem0.ai"` — matching that hostname exactly;
 * - a WILDCARD host — `"*.example"` — matching any subdomain of it (and not
 *   the bare domain);
 * - a URL PREFIX — anything containing `://` — matching any URL whose `href`
 *   starts with it.
 *
 * The most specific matching key answers: the longest URL prefix, then an exact
 * host, then the longest wildcard; a METHOD-qualified key beats the same key
 * without one. Ties keep declaration order.
 *
 * @module _route-keys
 */

/** A route key, split into its optional method and where it answers. */
export type RouteKey = {
  /** The key as written — what a table is indexed by and a log records. */
  readonly key: string;
  /** The upper-case method it is limited to, or `undefined` for any. */
  readonly method: string | undefined;
  /** The host, `*.suffix` wildcard or URL prefix. */
  readonly where: string;
};

const METHOD_KEY = /^([A-Z]+)\s+(\S.*)$/;

/** Split `key` into its optional method and where it answers. */
export function parseRouteKey(key: string): RouteKey {
  const trimmed = key.trim();
  const match = METHOD_KEY.exec(trimmed);
  return match
    ? { key, method: match[1], where: match[2] ?? "" }
    : { key, method: undefined, where: trimmed };
}

function whereMatches(where: string, url: URL): boolean {
  if (where.includes("://")) return url.href.startsWith(where);
  if (where.startsWith("*.")) return url.hostname.endsWith(where.slice(1));
  return url.hostname === where;
}

/** Does `key` (parsed or as written) answer a `method` request for `url`? */
export function routeKeyMatches(key: RouteKey | string, method: string, url: URL): boolean {
  const parsed = typeof key === "string" ? parseRouteKey(key) : key;
  return (
    (parsed.method === undefined || parsed.method === method.toUpperCase()) &&
    whereMatches(parsed.where, url)
  );
}

/** How specific a key is — among matching keys, higher answers first. */
export function routeKeySpecificity({ method, where }: RouteKey): number {
  const methodBonus = method === undefined ? 0 : 0.5;
  if (where.includes("://")) return 2_000_000 + where.length + methodBonus;
  if (where.startsWith("*.")) return where.length + methodBonus;
  return 1_000_000 + methodBonus;
}

/** One table entry a request matched. */
export type RouteMatch<V> = { readonly key: string; readonly value: V };

/** A keyed table, parsed once. */
export type RouteTable<V> = {
  /** Every entry matching the request, most specific first. */
  match(method: string, url: URL): RouteMatch<V>[];
  /** The most specific entry matching the request, if any. */
  best(method: string, url: URL): RouteMatch<V> | undefined;
};

/** Parse a table's keys once, for repeated matching. */
export function routeTable<V>(table: Readonly<Record<string, V>>): RouteTable<V> {
  const keys = Object.keys(table).map(parseRouteKey);
  const match = (method: string, url: URL): RouteMatch<V>[] =>
    keys
      .filter((key) => routeKeyMatches(key, method, url))
      // `sort` is stable, so equally specific keys keep declaration order.
      .sort((a, b) => routeKeySpecificity(b) - routeKeySpecificity(a))
      .map((key) => ({ key: key.key, value: table[key.key] as V }));
  return { match, best: (method, url) => match(method, url)[0] };
}

/** A `Request` as both fakes record it: method upper-cased, headers flattened. */
export type RequestRecord = {
  readonly url: string;
  readonly method: string;
  /** Names lower-cased, as `Headers` iterates them. */
  readonly headers: Record<string, string>;
  /** The body as text, read off a clone — `undefined` for a request with none. */
  readonly text: string | undefined;
};

/** Record `request` without consuming its body. */
export async function recordFetchRequest(request: Request): Promise<RequestRecord> {
  return {
    url: request.url,
    method: request.method.toUpperCase(),
    headers: Object.fromEntries(request.headers),
    text: request.body === null ? undefined : await request.clone().text(),
  };
}

/**
 * `text` parsed as JSON, boxed so a body of `null` is told apart from one that
 * is not JSON — `undefined` for an empty body or one that does not parse (a
 * form body, plain text), which each caller spells its own way.
 */
export function parseJsonText(text: string | undefined): { readonly json: unknown } | undefined {
  if (text === undefined || text === "") return undefined;
  try {
    return { json: JSON.parse(text) };
  } catch {
    return undefined;
  }
}
