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
 * server. Answers are immutable for a sandbox's lifetime, so they are
 * memoized per guest origin — the round trip to the sandbox tunnel is paid
 * once per sandbox, not once per page load.
 */

import { buildClientConfig, ClientConfigResponseSchema } from "@alexkroman1/aai/protocol";
import { HTTPException } from "hono/http-exception";
import { TtlCache } from "./_ttl-cache.ts";
import type { AppContext } from "./context.ts";
import { GUEST_ROUTES, guestHttpUrl } from "./guest-routes.ts";
import { brokerSessionUrl } from "./sandbox-broker.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";

/**
 * Per-request cap on the guest config proxy fetch. Short: this sits on the
 * page-load path and the fields are optional — degrading beats waiting.
 */
const GUEST_CONFIG_TIMEOUT_MS = 1500;

/**
 * How long a guest's answer is remembered. A guest origin is unique to one
 * sandbox and its config is immutable for that sandbox's life, so the TTL
 * exists to evict entries for dead sandboxes, not to refresh live ones.
 */
const GUEST_CONFIG_CACHE_TTL_MS = 10 * 60_000;

type GuestClientConfig = { name?: string; greeting?: string };

/**
 * Build the broker's request handler. A factory so the per-origin memo and
 * the injectable guest fetch (tests) live together — one cache per app.
 */
export function createAgentClientConfigHandler(
  fetchFn: typeof fetch = fetch,
): (c: AppContext, broker: ResolveSandboxOpts) => Promise<Response> {
  const memo = new TtlCache<GuestClientConfig>(GUEST_CONFIG_CACHE_TTL_MS);

  /**
   * The guest's own `/client-config` (public, same posture as the session
   * endpoint). Guest-asserted wire data — validated against the response
   * schema. Any failure (unreachable, non-200, malformed) degrades to `{}`
   * and is NOT cached, so a guest still booting answers on the next request
   * rather than pinning empty defaults for the TTL.
   */
  async function fetchGuestClientConfig(guestOrigin: string): Promise<GuestClientConfig> {
    const cached = memo.get(guestOrigin);
    if (cached) return cached;
    try {
      const url = guestHttpUrl(guestOrigin, GUEST_ROUTES.clientConfig);
      const res = await fetchFn(url, { signal: AbortSignal.timeout(GUEST_CONFIG_TIMEOUT_MS) });
      if (!res.ok) return {};
      const parsed = ClientConfigResponseSchema.safeParse(await res.json());
      if (!parsed.success) return {};
      const { name, greeting } = parsed.data;
      const config = {
        ...(name !== undefined ? { name } : {}),
        ...(greeting !== undefined ? { greeting } : {}),
      };
      memo.set(guestOrigin, config);
      return config;
    } catch {
      return {};
    }
  }

  return async (c, broker) => {
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

    const guestConfig = await fetchGuestClientConfig(brokered.guestOrigin);
    return c.json(
      buildClientConfig({
        ...guestConfig,
        sessionUrl: brokered.sessionUrl,
      }),
    );
  };
}
