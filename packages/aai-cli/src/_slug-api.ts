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

/** An already-resolved deployed target — what {@link slugRequestOn} needs. */
export type SlugTarget = { serverUrl: string; slug: string; apiKey: string };

/**
 * A slug-scoped request against an ALREADY-resolved target.
 *
 * {@link slugRequest} resolves per call, which is right for a command that
 * issues one request and wrong for one that POLLS. `aai logs --follow` re-entered
 * `getServerInfo` on every tick — a read and zod parse of `.aai/project.json`, a
 * read of the global config, a `new URL` trust check, a slug-shape test, and with
 * `--server` an `approveServer` that takes the CROSS-PROCESS config lock — once a
 * second for the life of the follow, all of it re-deriving an immutable answer.
 * `delete.ts` documents the same cost and answers it the same way, by hand; this
 * is the general version, so the next polling command inherits it.
 */
export async function slugRequestOn<T = unknown>(
  target: SlugTarget,
  resourcePath: string,
  init: SlugRequestInit,
): Promise<T> {
  const { serverUrl, slug, apiKey } = target;
  return deployedAgentRequest<T>(`${serverUrl}/${slug}${resourcePath}`, init, apiKey);
}

export async function slugRequest<T = unknown>(
  cwd: string,
  resourcePath: string,
  init: SlugRequestInit,
  server?: string,
): Promise<{ data: T; slug: string }> {
  const target = await getServerInfo(cwd, server);
  return { data: await slugRequestOn<T>(target, resourcePath, init), slug: target.slug };
}
