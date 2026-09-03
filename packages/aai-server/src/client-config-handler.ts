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
 * memoized per (slug, deploy version, guest origin) — the round trip to the
 * sandbox tunnel is paid once per sandbox, not once per page load. See
 * {@link memoKey} for why the origin alone is not enough.
 */

import { buildClientConfig, ClientConfigResponseSchema } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { TtlCache } from "./_ttl-cache.ts";
import type { AppContext } from "./context.ts";
import { forwardToGuest } from "./guest-forward.ts";
import { GUEST_ROUTES, guestHttpUrl } from "./guest-routes.ts";
import { brokerSessionUrlOrThrow } from "./sandbox-broker.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";

/**
 * Per-request cap on the guest config proxy fetch. Short: this sits on the
 * page-load path and the fields are optional — degrading beats waiting.
 */
const GUEST_CONFIG_TIMEOUT_MS = 1500;

/**
 * How long a guest's answer is remembered. A guest's config is immutable for
 * its sandbox's life, so the TTL exists to evict entries for dead sandboxes,
 * not to refresh live ones.
 */
const GUEST_CONFIG_CACHE_TTL_MS = 10 * 60_000;

/**
 * The memo key: slug, deploy version, guest origin.
 *
 * It was the ORIGIN alone, on the premise that "a guest origin is unique to one
 * sandbox". That holds for a Modal tunnel hostname and NOT for the subprocess
 * backend, whose guests are `ws://127.0.0.1:<port>` on a free port the OS is
 * free to hand out again: within the TTL, `GET /B/client-config` could be
 * answered with A's name and greeting once A's guest had exited and B's landed
 * on the same port. The slug is what makes that unrepresentable, and the
 * version is what stops a same-slug redeploy landing on the same port from
 * serving the previous build's name for up to ten minutes.
 *
 * NUL-separated for the same reason `projectKey` is (platform-events.ts): none
 * of the three parts can contain one, so no triple can spell another's key.
 */
function memoKey(slug: string, version: number | undefined, guestOrigin: string): string {
  return `${slug}\u0000${version ?? ""}\u0000${guestOrigin}`;
}

/**
 * The guest's own answer, minus `sessionUrl` (which is the BROKER's to say).
 *
 * `page` rides along for the same reason `name` does — it is the guest's live
 * agent definition talking, and the platform stores nothing it could read
 * instead. Without it the default client would render a start screen whose only
 * button opens a `/websocket` a `page: "static"` agent declines.
 */
type GuestClientConfig = { name?: string; greeting?: string; page?: "voice" | "static" };

/**
 * Build the broker's request handler. A factory so the memo and the injectable
 * guest fetch (tests) live together — one cache per app.
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
  async function fetchGuestClientConfig(
    key: string,
    guestOrigin: string,
  ): Promise<GuestClientConfig> {
    const cached = memo.get(key);
    if (cached) return cached;
    try {
      const res = await forwardToGuest({
        fetchFn,
        url: guestHttpUrl(guestOrigin, GUEST_ROUTES.clientConfig),
        // Nothing from the caller crosses: this hop is the PLATFORM asking a
        // guest to describe itself, not a proxied request.
        timeoutMs: GUEST_CONFIG_TIMEOUT_MS,
      });
      if (!res.ok) return {};
      const parsed = ClientConfigResponseSchema.safeParse(await res.json());
      if (!parsed.success) return {};
      const { name, greeting, page } = parsed.data;
      const config = omitUndefined({ name, greeting, page });
      memo.set(key, config);
      return config;
    } catch {
      return {};
    }
  }

  return async (c, broker) => {
    const slug = c.var.slug;
    const brokered = await brokerSessionUrlOrThrow(slug, broker);

    const guestConfig = await fetchGuestClientConfig(
      memoKey(slug, broker.slots.get(slug)?.version, brokered.guestOrigin),
      brokered.guestOrigin,
    );
    return c.json(
      buildClientConfig({
        ...guestConfig,
        sessionUrl: brokered.sessionUrl,
      }),
    );
  };
}
