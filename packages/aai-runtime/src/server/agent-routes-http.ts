// Copyright 2026 the AAI authors. MIT license.
/**
 * `/api/*` — `agent({ routes })`, the HTTP half: the prefix, the body cap, JSON
 * both ways (the request body's exact text handed on beside the parse, for a
 * webhook's signature), the headers as plain strings, and `?client=`.
 *
 * Mounted by `createServerForRuntime` beside the workflow API and the session
 * event stream, on the same lazy getter and for the same reason: every front
 * door — `aai dev`, a self-hosted server, a deployed guest — serves it
 * identically, and a guest builds its runtime on the first request that needs
 * one. The dispatch itself is the runtime's (`runtime/agent-routes.ts`), which is the
 * copy that holds the handlers; this side hands it strings and a parsed body.
 *
 * ## Claimed only when the agent declares routes
 *
 * An agent with no `routes` answers `undefined` for `serveRoute`, and then this
 * claims nothing: `/api/...` falls through to static serving and its 404, so a
 * client asset under `api/` keeps working for an agent that never opted in.
 *
 * ## No authentication — the routes are as open as the server
 *
 * Deliberately none added, and the module doc of `sdk/agent-routes.ts` says so
 * to the author. On a loopback `aai dev` that is the developer; on a server
 * reachable from a LAN it is anyone on it. `?client=` is VALIDATED here (the
 * id rule the voice socket and `/inbox` use) and then trusted, exactly as there.
 * The request headers are handed to the handler whole — cookies and
 * `Authorization` included — so a handler that checks a signature can; the SDK
 * module's security note tells the author to treat them as secrets.
 *
 * @internal
 */

import type http from "node:http";
import { CLIENT_ID_RE } from "@alexkroman1/aai/host-internal";
import { requestQuery } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { AgentRuntime } from "../runtime/index.ts";
import type { Logger } from "../runtime-config.ts";
import { BodyTooLargeError, claimUnder, readBody, sendJson } from "../workflow/api/http.ts";

/**
 * Where the routes are mounted. A request's path is matched against a route with
 * this cut off, so `GET /api/memories` is the route `"GET /memories"`.
 *
 * @internal
 */
export const AGENT_ROUTES_PREFIX = "/api";

/**
 * Largest request body a route is handed. The routes are small JSON for a
 * page — a memory, a reminder, a setting — and the cap is what bounds this
 * process's memory on a door that authenticates nobody.
 *
 * @internal
 */
export const MAX_ROUTE_BODY_BYTES = 64 * 1024;

/** The verbs whose body is read. A `GET` body means nothing and is not buffered. */
const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Is `url` (query already cut) under the prefix? `/api` itself, or `/api/…` — never `/apiary`. */
function underPrefix(url: string): boolean {
  return url === AGENT_ROUTES_PREFIX || url.startsWith(`${AGENT_ROUTES_PREFIX}/`);
}

/** First value per key — `RouteRequest.query`'s shape. */
function firstValues(params: URLSearchParams): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of params) if (!(key in query)) query[key] = value;
  return query;
}

/**
 * `RouteRequest.headers`' shape: Node already lower-cases the names; a header
 * Node keeps as a list (`set-cookie`, an unknown repeated one) is joined with
 * `", "`, so what crosses to the bundle is strings only.
 */
function headerValues(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * The body as JSON beside its exact text (what a webhook signature is computed
 * over), both `undefined` when there is none; throws `SyntaxError` on anything
 * that is not JSON.
 */
async function readJson(
  req: http.IncomingMessage,
): Promise<{ body: unknown; rawBody: string | undefined }> {
  const raw = (await readBody(req, MAX_ROUTE_BODY_BYTES)).toString("utf8");
  if (raw.trim() === "") return { body: undefined, rawBody: undefined };
  return { body: JSON.parse(raw), rawBody: raw };
}

/**
 * Build the `/api/*` handler over the runtime's `serveRoute`, read per request
 * — a GETTER, for the lazy-runtime reason in the module doc.
 *
 * @internal
 */
export function createAgentRoutesApi(
  serveRoute: () => AgentRuntime["serveRoute"],
  logger: Logger,
): (req: http.IncomingMessage, res: http.ServerResponse, url: string, method: string) => boolean {
  const handle = claimUnder<http.IncomingMessage, http.ServerResponse>({
    claims: () => true,
    label: "Agent route failed",
    logger,
    onError: (err, res) => {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: `Request body exceeds ${MAX_ROUTE_BODY_BYTES} bytes` });
        return true;
      }
      if (err instanceof SyntaxError) {
        sendJson(res, 400, { error: "Request body is not JSON" });
        return true;
      }
      return false;
    },
    route: async (req, res, url, method) => {
      const serve = serveRoute();
      if (!serve) return;
      const params = requestQuery(req.url);
      const client = params.get("client");
      if (client !== null && !CLIENT_ID_RE.test(client)) {
        sendJson(res, 400, { error: "?client= must be 1-64 letters, digits, - or _" });
        return;
      }
      const { body, rawBody } = BODY_METHODS.has(method)
        ? await readJson(req)
        : { body: undefined, rawBody: undefined };
      // Aborted when the caller hangs up before the answer is written, so a
      // handler's own fetch stops too. `close` after `finish` is the normal end.
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) controller.abort(new Error("the caller went away"));
      });
      const reply = await serve({
        method,
        path: url.slice(AGENT_ROUTES_PREFIX.length) || "/",
        query: firstValues(params),
        headers: headerValues(req.headers),
        body,
        signal: controller.signal,
        ...omitUndefined({ rawBody, clientId: client ?? undefined }),
      });
      if (reply.body === undefined) {
        res.writeHead(reply.status, { ...reply.headers });
        res.end();
        return;
      }
      // Serialized BEFORE the head is written, so a value JSON cannot carry (a
      // cycle, a BigInt) is still answerable as a 500 rather than a cut socket.
      const json = JSON.stringify(reply.body);
      res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
      res.end(json);
    },
  });
  // The prefix and the declaration are checked BEFORE claiming, so an agent with
  // no routes leaves `/api` to static serving — `claimUnder` claims synchronously.
  return (req, res, url, method) => {
    if (!underPrefix(url)) return false;
    try {
      if (serveRoute() === undefined) return false;
    } catch {
      // A guest runtime that cannot be built (no bundle yet, a missing provider
      // key) throws from the getter. Claimed, so `route` reads it again and the
      // throw becomes this surface's 500 rather than an exception in the server.
    }
    return handle(req, res, url, method);
  };
}
