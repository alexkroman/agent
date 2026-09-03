// Copyright 2025 the AAI authors. MIT license.
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

import { getServerInfo } from "./_agent.ts";
import { type ApiRequestOptions, apiRequest, HINT_NOT_DEPLOYED } from "./_api-client.ts";
import { studioProjectApiUrl } from "./_studio.ts";

/** What both requests below pass through to the API client. */
type SlugRequestInit = Pick<ApiRequestOptions, "method" | "body" | "action">;

/**
 * The request itself — one definition so the "not deployed" 404 hint this
 * module exists to attach cannot be present on one route and missing on the
 * other. Only the URL differs between the two callers.
 */
function deployedAgentRequest<T>(url: string, init: SlugRequestInit, apiKey: string): Promise<T> {
  return apiRequest<T>(url, { ...init, apiKey, hints: { 404: HINT_NOT_DEPLOYED } });
}

/**
 * A SECRET request, routed to the project when this directory is linked to
 * one and to the bare slug otherwise.
 *
 * A studio project deploys TWO agents — production and preview — and a
 * secret has to reach both or the preview fails at its first session while
 * production works. The project route fans out server-side
 * (`aai-studio-server/studio-secrets.ts`); this CLI used to write the
 * production slug alone, so a key set here was missing from the preview the
 * user's own `aai publish` had created. An unlinked directory has one agent
 * and keeps the per-slug route, which is the platform primitive underneath.
 */
export async function secretRequest<T = unknown>(
  cwd: string,
  resourcePath: string,
  init: SlugRequestInit,
  server?: string,
): Promise<{ data: T; target: string }> {
  const { serverUrl, slug, apiKey, studioProject } = await getServerInfo(cwd, server);
  const base = studioProject
    ? studioProjectApiUrl(serverUrl, studioProject)
    : `${serverUrl}/${slug}`;
  const data = await deployedAgentRequest<T>(`${base}/secret${resourcePath}`, init, apiKey);
  return { data, target: studioProject ?? slug };
}

export async function slugRequest<T = unknown>(
  cwd: string,
  resourcePath: string,
  init: SlugRequestInit,
  server?: string,
): Promise<{ data: T; slug: string }> {
  const { serverUrl, slug, apiKey } = await getServerInfo(cwd, server);
  const data = await deployedAgentRequest<T>(`${serverUrl}/${slug}${resourcePath}`, init, apiKey);
  return { data, slug };
}
