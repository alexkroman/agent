// Copyright 2026 the AAI authors. MIT license.
/**
 * `stubFetchRoutes` — one URL/method router standing in for BOTH fetches a
 * tool or a step can reach, with one log a spec asserts on.
 *
 * A custom tool calls the global `fetch`; a step calls `stepFetch`, which reads
 * a published slot and falls back to the global. A spec of an agent whose tools
 * talk to three services therefore wrote a `vi.stubGlobal("fetch", async (url,
 * init) => { … })` per file — parsing the URL, parsing the body, pushing onto a
 * `calls` array, and branching on host and method — and one downstream agent
 * had nine of them, no two agreeing on what an unexpected request meant. Most
 * answered it `200 {}`, which a tool reads as success.
 *
 * This is that function, written once: routes keyed by where they answer (the
 * key vocabulary `evalNetwork` uses, plus an optional METHOD), an unmatched
 * request that THROWS by default (the finding `routeStepFetch` argues for), and
 * every request recorded with its URL and body already parsed.
 *
 * `installFetchRoutes` (`@alexkroman1/aai/testing/vitest`) is the same fake,
 * restored when the test that installed it finishes.
 *
 * @module testing-fetch-routes
 */

import {
  recordRequest,
  type StubStepAnswer,
  type StubStepRequest,
  toStepResponse,
} from "./_testing-step-fetch.ts";
import { publishStepFetch, type StepFetchInit } from "./step-fetch.ts";

/**
 * One request as a route sees it: the recorded request (`url`, `method`,
 * `headers`, `body` — the same fields `stubStepFetch` records) plus the parts a
 * route branches on, already parsed.
 *
 * @public
 */
export type FetchRouteRequest = StubStepRequest & {
  /** `new URL(url).hostname`. */
  readonly host: string;
  /** `new URL(url).pathname`. */
  readonly pathname: string;
  /** `new URL(url).searchParams` — PostgREST filters, query strings. */
  readonly searchParams: URLSearchParams;
  /** The body parsed as JSON when it parses; `undefined` otherwise (and for none). */
  readonly json: unknown;
};

/**
 * A route: answers a request with a `Response` or the `{ status, body, headers }`
 * shorthand `stubStepFetch` takes — or `undefined` to DECLINE, leaving it to
 * the next route (in a list) or to {@link FetchRoutesOptions.unmatched}.
 *
 * A `StepRoute` (`routeStepFetch`'s leg, `stubGatewayRoute().route`) is one.
 *
 * @public
 */
export type FetchRouteHandler = (
  request: FetchRouteRequest,
) => StubStepAnswer | undefined | Promise<StubStepAnswer | undefined>;

/**
 * Routes by where they answer. A key is an optional METHOD, then one of:
 *
 * - a HOST — `"api.mem0.ai"` — matching that hostname exactly;
 * - a WILDCARD host — `"*.example"` — matching any subdomain of it;
 * - a URL PREFIX — `"https://api.mem0.ai/v3/memories/"` — matching any URL that
 *   starts with it.
 *
 * So `"POST textbelt.com"` answers only a POST. The most specific key answers:
 * a URL prefix (longest first), then an exact host, then a wildcard (longest
 * first); a METHOD-qualified key beats the same key without one. A value is a
 * {@link FetchRouteHandler}, or a fixed answer given to every request it
 * matches.
 *
 * @public
 */
export type FetchRouteTable = Readonly<Record<string, FetchRouteHandler | StubStepAnswer>>;

/** What {@link stubFetchRoutes} may be told. @public */
export type FetchRoutesOptions = {
  /**
   * What a request no route answers means.
   *
   * - `"throw"` (the default) — a finding: the fetch rejects naming the method
   *   and URL, the way an unreachable host does, and the request is logged
   *   with `outcome: "unmatched"`. An invented `200 {}` reads to a tool as
   *   success, so the spec would pass having tested the wrong branch.
   * - `"notFound"` — a real 404, for a spec whose subject is one.
   * - `"passthrough"` — the REAL network. Rarely right in a unit test.
   */
  unmatched?: "throw" | "notFound" | "passthrough" | undefined;
  /**
   * URLs that reach the REAL network before any route is consulted, tested
   * against the full URL — e.g. `/^https:\/\/[^/]*assemblyai\.com\//` for a
   * live model's own traffic.
   */
  passThrough?: RegExp | undefined;
  /**
   * Publish the router as the step fetch too (the default), so a step's
   * `stepFetch` lands in the same routes and the same log as a tool's
   * `fetch`. Pass `false` for a spec that installs its own step fetch.
   */
  stepFetch?: boolean | undefined;
};

/**
 * One request the router saw, whatever became of it.
 *
 * @public
 */
export type FetchRouteHit = FetchRouteRequest & {
  /** Answered by a route, sent to the real network, or answered by nothing. */
  readonly outcome: "routed" | "passthrough" | "unmatched";
  /** The table key that answered it (a list's routes have none). */
  readonly route?: string | undefined;
  /** Which fetch it arrived through. */
  readonly via: "fetch" | "stepFetch";
  /** The response's status, for a request that got one. */
  readonly status?: number | undefined;
};

/**
 * What {@link stubFetchRoutes} returns.
 *
 * @public
 */
export type StubFetchRoutes = {
  /** Every request, in order, including passed-through and unmatched ones. */
  readonly hits: FetchRouteHit[];
  /**
   * The hits a filter selects: a string matched the way a route KEY is
   * (`"POST supabase.test"`, `"*.example"`), a `RegExp` tested against the URL.
   */
  to(filter: string | RegExp): FetchRouteHit[];
  /** The router as a `fetch`, for code handed one explicitly. */
  readonly fetch: typeof globalThis.fetch;
  /** Put the global `fetch` back and unpublish the step fetch. */
  restore(): void;
};

/** A route key, split into the optional method and where it answers. */
type ParsedKey = { key: string; method: string | undefined; where: string };

const METHOD_KEY = /^([A-Z]+)\s+(\S.*)$/;

function parseKey(key: string): ParsedKey {
  const match = METHOD_KEY.exec(key.trim());
  return match
    ? { key, method: match[1], where: match[2] ?? "" }
    : { key, method: undefined, where: key.trim() };
}

function whereMatches(where: string, url: URL): boolean {
  if (where.includes("://")) return url.href.startsWith(where);
  if (where.startsWith("*.")) return url.hostname.endsWith(where.slice(1));
  return url.hostname === where;
}

function keyMatches(parsed: ParsedKey, method: string, url: URL): boolean {
  return (
    (parsed.method === undefined || parsed.method === method) && whereMatches(parsed.where, url)
  );
}

/** How specific a matching key is — higher answers first. */
function specificity({ method, where }: ParsedKey): number {
  const methodBonus = method === undefined ? 0 : 0.5;
  if (where.includes("://")) return 2_000_000 + where.length + methodBonus;
  if (where.startsWith("*.")) return where.length + methodBonus;
  return 1_000_000 + methodBonus;
}

function parseJson(body: Uint8Array | string | undefined): unknown {
  if (body === undefined) return;
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  if (text === "") return;
  try {
    return JSON.parse(text);
  } catch {
    // A form body or plain text: `json` stays undefined, `body` has it.
  }
}

function toRouteRequest(recorded: StubStepRequest): FetchRouteRequest {
  const url = new URL(recorded.url);
  return {
    ...recorded,
    host: url.hostname,
    pathname: url.pathname,
    searchParams: url.searchParams,
    json: parseJson(recorded.body),
  };
}

/** Record a GLOBAL fetch call the way `recordRequest` records a step's. */
async function recordGlobal(request: Request): Promise<StubStepRequest> {
  const text = request.body === null ? undefined : await request.clone().text();
  return {
    url: request.url,
    method: request.method.toUpperCase(),
    headers: Object.fromEntries(request.headers),
    body: text,
  };
}

/** A fixed table answer, fresh per request — a `Response` body is read once. */
function fixed(answer: StubStepAnswer): FetchRouteHandler {
  return () => (answer instanceof Response ? answer.clone() : answer);
}

/** The ordered candidate handlers for a request, most specific first. */
type Resolver = (request: FetchRouteRequest) => { route?: string; handler: FetchRouteHandler }[];

function resolverFor(routes: FetchRouteTable | readonly FetchRouteHandler[]): Resolver {
  if (Array.isArray(routes)) {
    const list = routes as readonly FetchRouteHandler[];
    return () => list.map((handler) => ({ handler }));
  }
  const table = routes as FetchRouteTable;
  const parsed = Object.keys(table).map(parseKey);
  return (request) => {
    const url = new URL(request.url);
    return parsed
      .filter((key) => keyMatches(key, request.method, url))
      .sort((a, b) => specificity(b) - specificity(a))
      .map((key) => {
        const value = table[key.key];
        return {
          route: key.key,
          handler: typeof value === "function" ? value : fixed(value as StubStepAnswer),
        };
      });
  };
}

/**
 * Install one router as the global `fetch` (and, by default, the published
 * step fetch), and return its log. Call `restore` when the test ends — or use
 * `installFetchRoutes`, which registers it for you.
 *
 * @example
 * ```ts
 * import { stubFetchRoutes } from "@alexkroman1/aai/testing";
 *
 * const net = stubFetchRoutes({
 *   "GET supabase.test": (req) => ({ body: req.searchParams.get("id") ? [{ id: 1 }] : [] }),
 *   "POST supabase.test": { status: 201 },
 *   "https://api.mem0.ai/v3/memories/": { body: { results: [] } },
 * });
 * await fetch("https://supabase.test/rest/v1/calls", { method: "POST", body: "{}" });
 * console.log(net.to("POST supabase.test").length); // 1
 * net.restore();
 * ```
 *
 * @param routes - A {@link FetchRouteTable}, or a list of handlers tried in
 *   order (the first that answers wins).
 * @public
 */
export function stubFetchRoutes(
  routes: FetchRouteTable | readonly FetchRouteHandler[],
  options: FetchRoutesOptions = {},
): StubFetchRoutes {
  const hits: FetchRouteHit[] = [];
  const resolve = resolverFor(routes);
  const unmatched = options.unmatched ?? "throw";
  const { fetch: original } = globalThis;

  async function dispatch(
    recorded: StubStepRequest,
    via: FetchRouteHit["via"],
    real: () => Promise<Response>,
  ): Promise<Response> {
    const request = toRouteRequest(recorded);
    const passedThrough = async (): Promise<Response> => {
      const response = await real();
      hits.push({ ...request, via, outcome: "passthrough", status: response.status });
      return response;
    };
    if (options.passThrough?.test(request.url)) return passedThrough();
    for (const { route, handler } of resolve(request)) {
      const answered = await handler(request);
      if (answered === undefined) continue;
      const response = toStepResponse(answered);
      hits.push({ ...request, via, outcome: "routed", route, status: response.status });
      return response;
    }
    if (unmatched === "passthrough") return passedThrough();
    if (unmatched === "notFound") {
      hits.push({ ...request, via, outcome: "unmatched", status: 404 });
      return toStepResponse({ status: 404, body: { error: `no fetch route for ${request.url}` } });
    }
    hits.push({ ...request, via, outcome: "unmatched" });
    // A TypeError, as an unreachable host's fetch rejects; naming the method
    // and URL answers the question this always raises: which route is missing.
    throw new TypeError(`no fetch route for ${request.method} ${request.url}`);
  }

  const routed = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    return dispatch(await recordGlobal(request), "fetch", () => original(request));
  }) as typeof globalThis.fetch;

  globalThis.fetch = routed;
  const publishStep = options.stepFetch ?? true;
  if (publishStep) {
    publishStepFetch(async (url: string, init: StepFetchInit = {}) => {
      const recorded = await recordRequest(url, init);
      return dispatch(recorded, "stepFetch", () =>
        original(url, {
          method: recorded.method,
          headers: recorded.headers,
          ...(recorded.body === undefined
            ? {}
            : { body: recorded.body as string | Uint8Array<ArrayBuffer> }),
        }),
      );
    });
  }

  return {
    hits,
    to(filter) {
      if (typeof filter !== "string") return hits.filter((hit) => filter.test(hit.url));
      const key = parseKey(filter);
      return hits.filter((hit) => keyMatches(key, hit.method, new URL(hit.url)));
    },
    fetch: routed,
    restore() {
      // Only if it is still ours: a later stub replaced it and owns putting
      // the global back.
      if (globalThis.fetch === routed) globalThis.fetch = original;
      if (publishStep) publishStepFetch(undefined);
    },
  };
}
