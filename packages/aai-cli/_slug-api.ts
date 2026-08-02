// Copyright 2025 the AAI authors. MIT license.

import { getServerInfo } from "./_agent.ts";
import { type ApiRequestOptions, apiRequest, HINT_NOT_DEPLOYED } from "./_api-client.ts";

/**
 * Authenticated request against a deployed agent's slug-scoped resource
 * (`${serverUrl}/${slug}${resourcePath}`) — the one shape every per-agent
 * command (secret, storage) shares, including the standard "not deployed"
 * 404 hint.
 *
 * Its own module (rather than living beside `getServerInfo` in `_agent.ts`)
 * so tests can mock `_agent.ts`/`_api-client.ts` while this composition
 * stays real — an intra-module call would bypass those mocks.
 */
export async function slugRequest<T = unknown>(
  cwd: string,
  resourcePath: string,
  init: Pick<ApiRequestOptions, "method" | "body" | "action">,
  server?: string,
): Promise<{ data: T; slug: string }> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, server);
  const data = await apiRequest<T>(`${serverUrl}/${slug}${resourcePath}`, {
    ...init,
    apiKey,
    hints: { 404: HINT_NOT_DEPLOYED },
  });
  return { data, slug };
}
