// Copyright 2026 the AAI authors. MIT license.
/**
 * Pre-connection client-config lookup.
 *
 * `GET client-config` (relative to the agent's base URL — see
 * `sdk/client-config.ts` in `@alexkroman1/aai`) gives the default client the
 * agent's display name and greeting before any connection exists. Every
 * failure path — network error, 404 from an older server, malformed body —
 * degrades to the empty default, so this lookup can never break an existing
 * agent.
 */

import {
  CLIENT_CONFIG_PATH,
  type ClientConfigResponse,
  ClientConfigResponseSchema,
} from "@alexkroman1/aai/protocol";

export type { ClientConfigResponse } from "@alexkroman1/aai/protocol";

/** Resolve a relative endpoint path against the agent's base URL. */
export function buildAgentUrl(platformUrl: string, endpointPath: string): URL {
  return new URL(endpointPath, platformUrl.endsWith("/") ? platformUrl : `${platformUrl}/`);
}

const AGENT_DEFAULT: ClientConfigResponse = {};

/** Fetch the agent's client config; any failure yields the agent default. */
export async function fetchClientConfig(
  platformUrl: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<ClientConfigResponse> {
  const doFetch =
    fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  try {
    const resp = await doFetch(buildAgentUrl(platformUrl, CLIENT_CONFIG_PATH).href);
    if (!resp.ok) return AGENT_DEFAULT;
    const parsed = ClientConfigResponseSchema.safeParse(await resp.json());
    return parsed.success ? parsed.data : AGENT_DEFAULT;
  } catch {
    return AGENT_DEFAULT;
  }
}
