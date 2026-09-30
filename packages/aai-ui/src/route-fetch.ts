// Copyright 2026 the AAI authors. MIT license.
/**
 * `routeFetch` — a call to the agent's OWN JSON routes, `agent({ routes })`,
 * which its server mounts under `/api`.
 *
 * Every page that used them wrote the same fifteen lines: resolve `/api/…`
 * against the page, add `?client=` (a route's `req.clientId` is how it knows
 * whose data to read), send the body as JSON, and turn a failure into an
 * `Error` carrying the route's own `{ error }` sentence rather than a status
 * code. Two of those are easy to get subtly wrong, and both are why this is
 * here:
 *
 * - **The URL is resolved against the page's DIRECTORY**, not the origin, so an
 *   agent served below a path (`/:slug/`) reaches its own `/:slug/api`. An
 *   absolute `/api/…` would reach the origin's.
 * - **A non-JSON failure** (a proxy's HTML 502, an empty 500) still becomes an
 *   `Error` naming the method, path and status, never a `SyntaxError` from
 *   parsing a body that was not JSON.
 *
 * `useRoute` (`use-route.ts`) is the reading half, for a component.
 *
 * @module
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { pageBaseUrl } from "./_utils.ts";

/**
 * The HTTP methods an `agent({ routes })` key can declare.
 *
 * @public
 */
export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Options for {@link routeFetch}.
 *
 * @public
 */
export type RouteFetchOptions = {
  /**
   * The client the call is about, sent as `?client=` — the route's
   * `req.clientId`. `useClientId()` is the session's; absent or empty sends
   * none.
   */
  client?: string | undefined;
  /** The agent's base URL. Default: the page's own directory. */
  baseUrl?: string | undefined;
  /** Abort the request. */
  signal?: AbortSignal | undefined;
};

/**
 * Call one of the agent's own routes and return its JSON — see this module's
 * doc for what it handles.
 *
 * `path` is the route as declared, without `/api`: `routeFetch("GET",
 * "/memories")` calls `"GET /memories"`. A body is sent as JSON. A response
 * that is not 2xx throws an `Error` whose message is the route's `{ error }`
 * field when it answered one (`routeResponse(404, { error: "No such memory" })`),
 * else `"<METHOD> <path>: <status>"`. A 2xx with no JSON body resolves `{}`.
 *
 * @example Saving a field for the session's client
 * ```tsx
 * import { routeFetch, useClientId } from "@alexkroman1/aai-ui";
 *
 * function SaveName({ name }: { name: string }) {
 *   const client = useClientId();
 *   return (
 *     <button type="button" onClick={() => void routeFetch("PUT", "/profile", { name }, { client })}>
 *       Save
 *     </button>
 *   );
 * }
 * ```
 *
 * @typeParam T - The shape the route answers. Not checked: annotate what you know.
 * @param method - The route's method.
 * @param path - The route's path as declared, starting with `/`; `?query` allowed.
 * @param body - Sent as JSON when given.
 * @param options - `client`, `baseUrl` and `signal`; see {@link RouteFetchOptions}.
 * @returns The parsed JSON body.
 *
 * @public
 */
export async function routeFetch<T = unknown>(
  method: RouteMethod,
  path: string,
  body?: unknown,
  options: RouteFetchOptions = {},
): Promise<T> {
  const base = options.baseUrl ?? pageBaseUrl();
  // Relative to the directory: `api/x` under `https://h/slug/` is `/slug/api/x`.
  const url = new URL(`api${path.startsWith("/") ? path : `/${path}`}`, base);
  if (options.client) url.searchParams.set("client", options.client);
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    ...omitUndefined({ signal: options.signal }),
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const said = isRecord(json) && typeof json.error === "string" ? json.error : undefined;
    throw new Error(said ?? `${method} ${path}: ${res.status}`);
  }
  return json as T;
}
