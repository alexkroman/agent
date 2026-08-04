// Copyright 2026 the AAI authors. MIT license.
/**
 * `GET /:slug/client-config` — the session broker.
 *
 * Pre-connection client config (see `sdk/client-config.ts` in
 * `@alexkroman1/aai`): the agent's name/greeting for the default client's
 * shell, plus `sessionUrl` — the public `/websocket` endpoint on the agent's
 * sandbox tunnel that clients connect to DIRECTLY (voice sessions no longer
 * pass through the platform host). Resolving the sandbox here is what boots
 * it on the first request. Same auth posture as the agent page and the
 * session endpoint itself: none.
 *
 * Name/greeting are PROXIED from the guest's own `/client-config` — the
 * bundle's live agent definition, interpreted by the bundle's own SDK —
 * rather than read out of the stored config. The stored config stays fully
 * opaque to the host (see `StoredAgentConfigSchema`): there is deliberately
 * no field a platform schema change could re-interpret under an
 * already-deployed agent. The guest fetch is best-effort — a guest that
 * cannot answer degrades to `{ sessionUrl }` and the default client renders
 * its empty defaults, exactly as it does against an older self-hosted
 * server.
 */

import { buildClientConfig, ClientConfigResponseSchema } from "@alexkroman1/aai/protocol";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./context.ts";
import { GUEST_ROUTES, guestHttpUrl } from "./guest-routes.ts";
import { brokerSessionUrl, type ResolveSandboxOpts } from "./sandbox-resolve.ts";

/** Per-request cap on the guest config proxy fetch. */
const GUEST_CONFIG_TIMEOUT_MS = 5000;

/**
 * Fetch the guest's own `/client-config` (public, same-posture as the
 * session endpoint). Guest-asserted wire data — validated against the
 * response schema, and any failure (unreachable, non-200, malformed)
 * degrades to `{}` rather than failing the broker: the session URL is the
 * part a client cannot do without.
 */
async function fetchGuestClientConfig(
  sessionUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ name?: string; greeting?: string }> {
  try {
    const origin = new URL(sessionUrl);
    const url = guestHttpUrl(`${origin.protocol}//${origin.host}`, GUEST_ROUTES.clientConfig);
    const res = await fetchFn(url, { signal: AbortSignal.timeout(GUEST_CONFIG_TIMEOUT_MS) });
    if (!res.ok) return {};
    const parsed = ClientConfigResponseSchema.safeParse(await res.json());
    if (!parsed.success) return {};
    const { name, greeting } = parsed.data;
    return {
      ...(name !== undefined ? { name } : {}),
      ...(greeting !== undefined ? { greeting } : {}),
    };
  } catch {
    return {};
  }
}

export async function handleAgentClientConfig(
  c: AppContext,
  broker: ResolveSandboxOpts,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const slug = c.var.slug;
  const brokered = await brokerSessionUrl(slug, broker);

  if (!brokered.ok) {
    if (brokered.status === 404) {
      throw new HTTPException(404, { message: `Not found: ${slug}` });
    }
    // The sandbox VM failed to start; the failure hook detaches it so the
    // next request rebuilds. Tell this client to retry rather than handing
    // it a session URL that will never answer.
    throw new HTTPException(503, {
      message: "agent unavailable, retry shortly",
      cause: brokered.cause,
    });
  }

  const guestConfig = await fetchGuestClientConfig(brokered.sessionUrl, fetchFn);
  return c.json(
    buildClientConfig({
      ...guestConfig,
      sessionUrl: brokered.sessionUrl,
    }),
  );
}
