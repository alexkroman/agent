// Copyright 2026 the AAI authors. MIT license.
/**
 * `evalNetwork` — a fake network for evals that FAILS CLOSED.
 *
 * An eval drives the agent's real tools, and a real tool makes real requests:
 * a CRM write, a text message, a phone call placed through a carrier. Every
 * downstream suite that evaluated such an agent wrote the same fake by hand —
 * a `fetch` that answered a handful of hosts from fixtures and forwarded the
 * rest — and each got two things wrong in the same way:
 *
 * - **It failed OPEN.** "Anything not faked goes to the real network" is the
 *   default a hand-rolled fake falls into, because the live MODEL's requests go
 *   through the same global `fetch` and must reach it. One suite forwarded
 *   everything whose URL did not contain `supabase`; the carrier it never
 *   meant to reach was one typo away.
 * - **It was stubbed THREE times.** A custom tool calls the global `fetch`, a
 *   builtin takes the session's `fetch` option, and a workflow step reads the
 *   published step fetch. A suite that stubbed two of the three had a hole it
 *   could not see.
 *
 * So this inverts the default. A request is answered by a ROUTE, passed
 * through only to a host named in `passthrough`, or REFUSED — thrown as a
 * network failure (or a 403, if asked) and recorded, so the case can assert
 * nothing was refused or that one particular host was never tried. The live
 * model's own provider hosts are the one passthrough nobody should have to
 * name: `describeEval` works them out from the agent and adds them, and keeps
 * that traffic out of the log (it is the harness's, not the agent's).
 *
 * Handed to `describeEval` as `network`, it becomes all three of the fetches
 * above for every case — see `DescribeEvalOptions.network`. Standalone, its
 * {@link EvalNetwork.fetch} is an ordinary `fetch` for `openEvalSession`'s
 * `fetch` option or anything else.
 *
 * ```ts
 * import { evalNetwork } from "@alexkroman1/aai-runtime/eval";
 *
 * const net = evalNetwork({
 *   routes: {
 *     "api.open-meteo.com": () => ({ current: { temperature_2m: 54.4 } }),
 *     "https://crm.example/rest/v1/calls": async (request) =>
 *       request.method === "POST" ? new Response(null, { status: 201 }) : [],
 *   },
 * });
 * await net.fetch("https://api.open-meteo.com/v1/forecast?latitude=44");
 * console.log(net.calls("api.open-meteo.com").length); // 1
 * await net.fetch("https://api.twilio.com/2010-04-01/Calls").catch(() => undefined);
 * console.log(net.refused().map((r) => r.host)); // ["api.twilio.com"]
 * ```
 *
 * @module
 */

import { errorMessage } from "@alexkroman1/aai/utils";

/**
 * One request the network saw, whatever became of it.
 *
 * @sealed
 */
export type EvalRequest = {
  /** Upper-case, `"GET"` when the caller named none. */
  readonly method: string;
  readonly url: URL;
  /** `url.hostname`, the key most assertions filter on. */
  readonly host: string;
  /** The request's headers, names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body as text — `""` for none. */
  readonly text: string;
  /**
   * The body parsed as JSON when it parses, else {@link EvalRequest.text};
   * `undefined` for a request with no body.
   */
  readonly body: unknown;
  /**
   * What became of it: answered by a `route`, sent on to the real network
   * (`passthrough`), or `refused`.
   */
  readonly outcome: "routed" | "passthrough" | "refused";
  /** The route key that answered it, for `outcome: "routed"`. */
  readonly route?: string;
  /** The response's status, for a request that got one. */
  readonly status?: number;
};

/**
 * A route handler: the request (a fresh `Request`, so its body is readable),
 * the record the log holds for it with the body already parsed, and the
 * network's {@link EvalNetworkOptions.state} — `undefined` when it has none.
 *
 * It returns a `Response`, used as is; `undefined`, answered `204 No Content`;
 * or any other value, answered as `200` JSON — so a fixture route is one line.
 * A handler that THROWS answers `500` with the message, and the case sees what
 * its tool made of a failing service.
 */
export type EvalRoute<State = undefined> = (
  request: Request,
  info: EvalRequest,
  state: State,
) => unknown;

/** What {@link evalNetwork} takes. */
export type EvalNetworkOptions<State = undefined> = {
  /**
   * The fake services' STATE — the rows a fake database holds — built by
   * this factory now and again on every {@link EvalNetwork.reset}, handed to
   * every route as its third argument, and readable as
   * {@link EvalNetwork.state}, typed.
   *
   * The supported way for a route and a case to share state. Without it a
   * suite kept its fake table in a module-level `let` that its network
   * factory reassigned, which a case read by name and a second suite could
   * not have without a second `let`. And because `reset()` rebuilds it,
   * `describeEval` gives every case and every `AAI_EVAL_REPEAT` repeat fresh
   * state from an INSTANCE too, not only from a factory.
   *
   * ```ts
   * import { evalNetwork } from "@alexkroman1/aai-runtime/eval";
   *
   * const crm = evalNetwork({
   *   state: () => ({ notes: [] as string[] }),
   *   routes: {
   *     "https://crm.example/notes": (_request, { method, text }, state) => {
   *       if (method === "POST") state.notes.push(text);
   *       return { count: state.notes.length };
   *     },
   *   },
   * });
   * await crm.fetch("https://crm.example/notes", { method: "POST", body: "call back" });
   * console.log(crm.state.notes); // ["call back"]
   * ```
   */
  readonly state?: () => State;
  /**
   * Handlers by where they answer. A key is one of:
   *
   * - a HOST — `"api.mem0.ai"` — matching that hostname exactly;
   * - a WILDCARD host — `"*.example"` — matching any subdomain of it (and not
   *   the bare domain);
   * - a URL PREFIX — `"https://crm.example/rest/v1/calls"` — matching any URL
   *   that starts with it.
   *
   * The most specific key answers: the longest matching URL prefix, then an
   * exact host, then the longest matching wildcard.
   */
  readonly routes?: Readonly<Record<string, EvalRoute<State>>>;
  /**
   * Keys (same forms as `routes`) that reach the REAL network. Leave the live
   * model's own hosts out — `describeEval` adds those — and list anything else
   * only when a case genuinely means to leave the machine.
   */
  readonly passthrough?: readonly string[];
  /**
   * How an unrouted request is refused. `"throw"` (the default) rejects the
   * `fetch` the way an unreachable host does, which is the failure a tool most
   * reliably surfaces; `"403"` answers `403 Forbidden`, for an agent whose tool
   * swallows network errors but reports statuses. Either way it is recorded.
   */
  readonly refuse?: "throw" | "403";
};

/** Which requests a query selects: a key (as a route key), a URL pattern, or a predicate. */
export type EvalRequestFilter = string | RegExp | ((request: EvalRequest) => boolean);

/**
 * A fake network and its request log.
 *
 * @sealed
 */
export type EvalNetwork<State = unknown> = {
  /** The network as a `fetch`: routed, passed through, or refused. */
  readonly fetch: typeof globalThis.fetch;
  /**
   * The routes' shared state, as {@link EvalNetworkOptions.state} built it —
   * the CURRENT one, rebuilt by every {@link EvalNetwork.reset}. `undefined`
   * for a network given no `state`.
   */
  readonly state: State;
  /**
   * Every request so far, in order, whatever its outcome — narrowed by a
   * `filter` when one is given: a string is matched the way a route key is, a
   * `RegExp` is tested against the full URL.
   */
  requests(filter?: EvalRequestFilter): readonly EvalRequest[];
  /**
   * The requests a HOST really received — routed or passed through, never
   * refused. A string matches the way a route key does (`"*.example"` works);
   * a `RegExp` is tested against the hostname.
   */
  calls(host: string | RegExp): readonly EvalRequest[];
  /** Every refused request, in order. */
  refused(): readonly EvalRequest[];
  /**
   * Throw, listing them, when any request matching `filter` was even
   * ATTEMPTED — refused ones included. "It never tried to reach the carrier"
   * is the claim, and a refusal is a try.
   */
  expectNoOutbound(filter: EvalRequestFilter): void;
  /** Throw, listing them, when anything was refused. */
  expectNothingRefused(): void;
  /**
   * Forget the log and rebuild {@link EvalNetwork.state}. `describeEval` calls
   * it before every case and every `AAI_EVAL_REPEAT` repeat. State a handler
   * keeps in its own closure is not reset — put it in `state`, or pass
   * `describeEval` a factory rather than an instance.
   */
  reset(): void;
};

/**
 * The fetch a passthrough is sent with. `describeEval` records the global it
 * replaced here, so a network built INSIDE a case (after the global was
 * swapped for the harness's dispatcher) still reaches the real network rather
 * than routing back into itself.
 */
let realFetch: typeof globalThis.fetch | undefined;

/** @internal — `_network-install.ts`'s half: the global it replaced, or `undefined` on restore. */
export function setEvalPassthroughFetch(fetchFn: typeof globalThis.fetch | undefined): void {
  realFetch = fetchFn;
}

/**
 * The fetch a passthrough reaches: the global `describeEval` replaced, or the
 * global itself for a network used standalone.
 *
 * The AMBIENT fetch on purpose, which `guard-invariants` rule 29 bans as a
 * runtime egress default — and this is not one. A passthrough exists for the
 * live model, whose provider client resolves this same global per call (the
 * argument `providers/_request-body-extras.ts` carries at its baselined line):
 * sending the model's traffic over the pooled egress fetch would move it onto
 * a transport it never uses in production. One request a turn, never a
 * fan-out at one origin.
 *
 * @internal
 */
export function evalPassthroughFetch(): typeof globalThis.fetch {
  if (realFetch !== undefined) return realFetch;
  const { fetch: ambient } = globalThis;
  return ambient;
}

/** Does a route/passthrough KEY match `url`? */
export function keyMatches(key: string, url: URL): boolean {
  if (key.includes("://")) return url.href.startsWith(key);
  if (key.startsWith("*.")) return url.hostname.endsWith(key.slice(1));
  return url.hostname === key;
}

/** How specific a matching key is — higher answers first. */
function specificity(key: string): number {
  if (key.includes("://")) return 2_000_000 + key.length;
  if (key.startsWith("*.")) return key.length;
  return 1_000_000;
}

/** The most specific key in `keys` matching `url`, if any. */
function bestKey(keys: readonly string[], url: URL): string | undefined {
  let best: string | undefined;
  for (const key of keys) {
    if (!keyMatches(key, url)) continue;
    if (best === undefined || specificity(key) > specificity(best)) best = key;
  }
  return best;
}

function selects(filter: EvalRequestFilter, request: EvalRequest): boolean {
  if (typeof filter === "function") return filter(request);
  if (typeof filter === "string") return keyMatches(filter, request.url);
  return filter.test(request.url.href);
}

/** One line per request, for a failure message. */
function describeRequest(request: EvalRequest): string {
  const status = request.status === undefined ? "" : ` ${request.status}`;
  return `${request.method} ${request.url.href} (${request.outcome}${status})`;
}

/**
 * One line per DISTINCT request, in first-seen order, a repeat counted rather
 * than listed again (`… (refused) ×2`). A builtin that retries a refused
 * request is one thing the agent reached for, and listing it twice read as two.
 */
export function describeRequests(requests: readonly EvalRequest[]): string[] {
  const counts = new Map<string, number>();
  for (const request of requests) {
    const line = describeRequest(request);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts].map(([line, n]) => (n === 1 ? line : `${line} ×${n}`));
}

/** The value a route returned, as a Response. */
function asResponse(value: unknown): Response {
  if (value instanceof Response) return value;
  if (value === undefined) return new Response(null, { status: 204 });
  return Response.json(value);
}

function parsed(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A form body or plain text stays a string.
    return text;
  }
}

/**
 * Build a fake network: every request is answered by a route, passed through
 * to a host named in `passthrough`, or refused and recorded.
 */
export function evalNetwork<State = undefined>(
  options: EvalNetworkOptions<State> = {},
): EvalNetwork<State> {
  const routes = options.routes ?? {};
  const routeKeys = Object.keys(routes);
  const passthrough = options.passthrough ?? [];
  let log: EvalRequest[] = [];
  // No factory means no state: `State` then defaults to `undefined`, which is
  // what this reads as. A route that annotated a state type without a factory
  // is the one way to reach it mistyped.
  const initial = (): State => options.state?.() as State;
  let state = initial();

  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.body === null ? "" : await request.clone().text();
    const base = {
      method: request.method.toUpperCase(),
      url,
      host: url.hostname,
      headers: Object.fromEntries(request.headers),
      text,
      body: parsed(text),
    };
    const route = bestKey(routeKeys, url);
    const handler = route === undefined ? undefined : routes[route];
    if (route !== undefined && handler !== undefined) {
      const info: EvalRequest = { ...base, outcome: "routed", route };
      let response: Response;
      try {
        response = asResponse(await handler(request, info, state));
      } catch (err) {
        response = new Response(
          `eval network: the route for ${route} threw — ${errorMessage(err)}`,
          {
            status: 500,
          },
        );
      }
      log.push({ ...info, status: response.status });
      return response;
    }
    if (bestKey(passthrough, url) !== undefined) {
      const response = await evalPassthroughFetch()(request);
      log.push({ ...base, outcome: "passthrough", status: response.status });
      return response;
    }
    return refuse({ ...base, outcome: "refused" });
  };

  const refuse = (record: EvalRequest): Response => {
    const why =
      `eval network: refused ${record.method} ${record.url.href} — no route matches it and ` +
      `it is not a passthrough host. Add a route for "${record.host}" to evalNetwork({ routes }) ` +
      "if the agent is meant to reach it.";
    if (options.refuse === "403") {
      log.push({ ...record, status: 403 });
      return new Response(why, { status: 403 });
    }
    log.push(record);
    throw new TypeError(why);
  };

  const requests = (filter?: EvalRequestFilter): readonly EvalRequest[] =>
    filter === undefined ? [...log] : log.filter((r) => selects(filter, r));

  const refused = (): EvalRequest[] => log.filter((r) => r.outcome === "refused");
  return {
    fetch: fetchFn as typeof globalThis.fetch,
    get state() {
      return state;
    },
    requests,
    calls: (host) =>
      log.filter(
        (r) =>
          r.outcome !== "refused" &&
          (typeof host === "string" ? keyMatches(host, r.url) : host.test(r.host)),
      ),
    refused,
    expectNoOutbound(filter) {
      const tried = requests(filter);
      if (tried.length === 0) return;
      throw new Error(
        `eval network: expected no request to ${String(filter)}, and ${tried.length} were ` +
          `attempted:\n${describeRequests(tried)
            .map((line) => `  ${line}`)
            .join("\n")}`,
      );
    },
    expectNothingRefused() {
      const denied = refused();
      if (denied.length === 0) return;
      throw new Error(
        `eval network: ${denied.length} request(s) were refused — each is a host the agent ` +
          `reached for that no route answers:\n${describeRequests(denied)
            .map((line) => `  ${line}`)
            .join("\n")}`,
      );
    },
    reset() {
      log = [];
      state = initial();
    },
  };
}
