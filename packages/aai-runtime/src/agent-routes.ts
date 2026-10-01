// Copyright 2026 the AAI authors. MIT license.
/**
 * `agent({ routes })`, the RUNTIME's half: the route table compiled once, and
 * one call that answers a parsed request with a status and a JSON body.
 *
 * The HTTP half — the `/api` prefix, the body cap, JSON parsing, `?client=` —
 * is `agent-routes-http.ts`, and the line between them is the bundle boundary.
 * A deployed guest holds two copies of this package (see "A deployed guest has
 * TWO copies of this package" in this package's guide): `createRuntimeServer`
 * is the harness's, while the runtime — and the handlers, and the
 * `routeResponse` they return — are the agent bundle's. So what crosses is
 * data: a request of strings (headers and the raw body text included) and a
 * parsed body in, `{ status, body }` out, and a `routeResponse` is recognized
 * by its `Symbol.for` brand (`readRouteResponse`), never by `instanceof`. `aai dev` has the same seam
 * with one copy of this package and two of the SDK, which is why the brand is
 * the SDK's to read.
 *
 * ## The table is compiled at `createRuntime`, and a bad key fails there
 *
 * `"GET memories"` (no slash) or `"FETCH /x"` would otherwise be a route that
 * never matches — a 404 in the browser with nothing naming the typo. Refused
 * when the runtime is built, a mistake is the restart loop's error under `aai
 * dev` and a failed boot anywhere else, which is where a declaration mistake
 * belongs. Two keys that match the same requests (`/a/:x` and `/a/:y` under one
 * method) are refused for the same reason: one of them could never run.
 *
 * ## Matching: a literal segment beats a parameter
 *
 * `GET /memories/recent` and `GET /memories/:id` both match `/memories/recent`,
 * and the author plainly means the first. So among the routes that match, the
 * one whose FIRST differing segment is literal wins — independent of the order
 * the object literal happened to list them in.
 *
 * @internal
 */

import type { RouteContext, RouteHandler, RouteRequest } from "@alexkroman1/aai";
import { CLIENT_ID_RE, readRouteError, readRouteResponse } from "@alexkroman1/aai/host-internal";
import { rejectingWorkflows, WORKFLOWS_UNAVAILABLE_MESSAGE } from "@alexkroman1/aai/internal";
import type { ClientTranscript, StepClientTranscriptOptions } from "@alexkroman1/aai/step";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import type { Logger } from "./runtime-config.ts";
import type { AgentRuntime } from "./runtime-types.ts";
import type { SpeechDirectory } from "./session/index.ts";
import { type ClientHistoryDeps, readClientTranscript } from "./session/index.ts";

/**
 * The methods a route key may name — also what `SERVER_ROUTES.api` declares, so
 * the platform's exposure table and this parser cannot disagree.
 *
 * @internal
 */
export const ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** `<METHOD> /<path>` — one space, a leading slash, no whitespace in the path. */
const ROUTE_KEY_RE = /^([A-Z]+) (\/\S*)$/;

/** A `:name` segment's name. */
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One path segment of a compiled route: a literal to compare, or a parameter to capture. */
type Segment = { literal: string } | { param: string };

type CompiledRoute = {
  key: string;
  method: string;
  segments: readonly Segment[];
  handler: RouteHandler;
};

/** What `serveRoute` takes: a request the HTTP half has already parsed. */
export type RouteCall = Parameters<NonNullable<AgentRuntime["serveRoute"]>>[0];

/** Split a path into its segments: `/a/b/` and `/a/b` are the same route. */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

function compileKey(key: string, handler: unknown): CompiledRoute {
  const match = ROUTE_KEY_RE.exec(key);
  const method = match?.[1];
  const path = match?.[2];
  if (method === undefined || path === undefined) {
    throw new Error(
      `agent({ routes }): "${key}" is not "<METHOD> /<path>" — e.g. "GET /memories/:id"`,
    );
  }
  if (!(ROUTE_METHODS as readonly string[]).includes(method)) {
    throw new Error(
      `agent({ routes }): "${key}" names ${method}; a route is one of ${ROUTE_METHODS.join(", ")}`,
    );
  }
  if (typeof handler !== "function") {
    throw new Error(`agent({ routes }): "${key}" is not a function`);
  }
  const segments = segmentsOf(path).map((raw): Segment => {
    if (!raw.startsWith(":")) return { literal: raw };
    const param = raw.slice(1);
    if (!PARAM_NAME_RE.test(param)) {
      throw new Error(`agent({ routes }): "${key}" has a parameter ":${param}" that is not a name`);
    }
    return { param };
  });
  return { key, method, segments, handler: handler as RouteHandler };
}

/** The shape two routes would both match: literals kept, parameters blanked. */
function shapeOf(route: CompiledRoute): string {
  return `${route.method} /${route.segments.map((s) => ("literal" in s ? s.literal : ":")).join("/")}`;
}

/** The params `route` captures from `parts`, or `undefined` when it does not match. */
function captures(
  route: CompiledRoute,
  parts: readonly string[],
): Record<string, string> | undefined {
  if (route.segments.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (const [i, segment] of route.segments.entries()) {
    const part = parts[i] ?? "";
    if ("literal" in segment) {
      if (segment.literal !== part) return undefined;
    } else {
      params[segment.param] = part;
    }
  }
  return params;
}

/** Negative when `a` is the more specific: its first differing segment is the literal one. */
function bySpecificity(a: CompiledRoute, b: CompiledRoute): number {
  for (const [i, segment] of a.segments.entries()) {
    const other = b.segments[i];
    const aLiteral = "literal" in segment;
    const bLiteral = other !== undefined && "literal" in other;
    if (aLiteral !== bLiteral) return aLiteral ? -1 : 1;
  }
  return 0;
}

/** Decode one path segment; a malformed escape is kept as it arrived rather than thrown. */
function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Compile `agent.routes` into the runtime's `serveRoute`, or `undefined` for an
 * agent that declares none — which is what leaves `/api` to static serving.
 *
 * Throws on a malformed key; see the module doc.
 *
 * @internal
 */
export function compileAgentRoutes(deps: {
  routes: Readonly<Record<string, RouteHandler>> | undefined;
  /** The AGENT's env — what a tool reads as `ctx.env`. */
  env: Readonly<Partial<Record<string, string>>>;
  workflows: WorkflowClient | undefined;
  /** The durable client log `ctx.clientTranscript` reads. */
  history: ClientHistoryDeps;
  logger: Logger;
  /** What `ctx.speech(sessionId)` answers — see `SpeechDirectory.live`. */
  speech: Pick<SpeechDirectory, "live">;
}): AgentRuntime["serveRoute"] {
  const { routes, env, history, logger, speech } = deps;
  if (routes === undefined) return undefined;
  const table = Object.entries(routes)
    .map(([key, handler]) => compileKey(key, handler))
    .sort(bySpecificity);
  const shapes = new Map<string, string>();
  for (const route of table) {
    const shape = shapeOf(route);
    const clash = shapes.get(shape);
    if (clash !== undefined) {
      throw new Error(
        `agent({ routes }): "${route.key}" and "${clash}" match the same requests; one could never run`,
      );
    }
    shapes.set(shape, route.key);
  }
  const workflows = deps.workflows ?? rejectingWorkflows(WORKFLOWS_UNAVAILABLE_MESSAGE);
  const clientTranscript = async (
    clientId: string,
    options: StepClientTranscriptOptions = {},
  ): Promise<ClientTranscript> => {
    if (!CLIENT_ID_RE.test(clientId)) {
      throw new Error(`clientTranscript: "${clientId}" is not a client id (${CLIENT_ID_RE})`);
    }
    return await readClientTranscript(history, clientId, options);
  };

  return async (call) => {
    const parts = segmentsOf(call.path).map(decodeSegment);
    const matching = table.flatMap((route) => {
      const params = captures(route, parts);
      return params === undefined ? [] : [{ route, params }];
    });
    const hit = matching.find((m) => m.route.method === call.method);
    if (hit === undefined) {
      if (matching.length === 0) return { status: 404, body: { error: "Not found" } };
      const allow = [...new Set(matching.map((m) => m.route.method))];
      return {
        status: 405,
        body: { error: `${call.path} answers ${allow.join(", ")}` },
        headers: { Allow: allow.join(", ") },
      };
    }
    const request: RouteRequest = {
      method: call.method,
      path: call.path,
      params: hit.params,
      query: { ...call.query },
      headers: { ...call.headers },
      body: call.body,
      ...omitUndefined({ rawBody: call.rawBody, clientId: call.clientId }),
    };
    const context: RouteContext = {
      env,
      workflows,
      clientTranscript,
      speech: speech.live,
      signal: call.signal,
    };
    try {
      const value: unknown = await hit.route.handler(request, context);
      return readRouteResponse(value) ?? { status: 200, body: value ?? null };
    } catch (err: unknown) {
      // A `routeError(status, message)` is the handler ANSWERING, not failing:
      // its status and sentence go back as they are, and nothing is logged.
      const refusal = readRouteError(err);
      if (refusal !== undefined)
        return { status: refusal.status, body: { error: refusal.message } };
      // The MESSAGE only: a stack names this server's files, and the caller is
      // whoever can reach the port. The log gets the route, never the body.
      const message = errorMessage(err);
      logger.warn("Agent route failed", { route: hit.route.key, error: message });
      return { status: 500, body: { error: message } };
    }
  };
}
