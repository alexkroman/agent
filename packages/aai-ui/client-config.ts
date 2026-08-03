// Copyright 2026 the AAI authors. MIT license.
/**
 * Pre-connection client-config lookup.
 *
 * `GET client-config` (relative to the agent's base URL — see
 * `sdk/client-config.ts` in `@alexkroman1/aai`) gives the default client the
 * agent's display name and greeting before any connection exists. For that
 * use every failure path — network error, 404 from an older server,
 * malformed body — degrades to the empty default (`fetchClientConfig`), so
 * the lookup can never break an existing agent.
 *
 * The session's broker decision needs the opposite: `loadClientConfig`
 * keeps "the lookup failed" (`null`) distinct from "the server answered and
 * named no sessionUrl" (`{}`). See its doc comment.
 */

import {
  CLIENT_CONFIG_PATH,
  type ClientConfigResponse,
  ClientConfigResponseSchema,
} from "@alexkroman1/aai/protocol";

/** @internal Re-exported for the sibling modules; the SDK's `/protocol` subpath is the canonical home. */
export type { ClientConfigResponse } from "@alexkroman1/aai/protocol";

/**
 * Resolve a relative endpoint path against the agent's base URL.
 *
 * @internal
 */
export function buildAgentUrl(platformUrl: string, endpointPath: string): URL {
  return new URL(endpointPath, platformUrl.endsWith("/") ? platformUrl : `${platformUrl}/`);
}

const AGENT_DEFAULT: ClientConfigResponse = {};

/**
 * Fetch the agent's client config, reporting `null` when the lookup did not
 * produce an answer (network error, non-2xx, unparsable body).
 *
 * The distinction from `fetchClientConfig` matters for exactly one caller:
 * the session's per-attempt broker decision. A config that ARRIVED and named
 * no `sessionUrl` means "this server is not a broker" (`aai dev`, an older
 * server) — a durable fact worth latching. A lookup that FAILED means
 * nothing about the server, and treating the two alike is how a single 503
 * (a sandbox mid-boot, or one that failed to start) pinned a session to the
 * platform's `/:slug/websocket` — a WebSocket redirect browsers don't
 * follow, so every retry failed with no re-brokering even after the agent
 * recovered.
 *
 * @internal
 */
export async function loadClientConfig(
  platformUrl: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<ClientConfigResponse | null> {
  const doFetch =
    fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  try {
    const resp = await doFetch(buildAgentUrl(platformUrl, CLIENT_CONFIG_PATH).href);
    if (!resp.ok) return null;
    const parsed = ClientConfigResponseSchema.safeParse(await resp.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the agent's client config; any failure yields the agent default.
 *
 * @internal
 */
export async function fetchClientConfig(
  platformUrl: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<ClientConfigResponse> {
  return (await loadClientConfig(platformUrl, fetchFn)) ?? AGENT_DEFAULT;
}
