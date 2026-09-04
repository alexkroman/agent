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

// A lookup that produced no answer degrades to the voice front door — the one
// this client can actually mount, and what an absent `page` used to encode.
const AGENT_DEFAULT: ClientConfigResponse = { page: "voice" };

/**
 * Per-attempt deadline for the `client-config` lookup.
 *
 * A request issued while the platform is restarting or saturated can HANG
 * rather than fail — the proxy holds the socket open — and a browser fetch
 * has no timeout of its own. Every other failure here is already handled
 * (`null`, then the same-origin fallback), but a hang is not a failure: the
 * promise simply never settles.
 *
 * That is unrecoverable rather than merely slow, because this lookup runs
 * inside the session's WebSocket URL *provider*. partysocket awaits the
 * provider under `_connectLock` and arms its own `connectionTimeout` only
 * AFTER the URL resolves, so a hung lookup means no socket is ever
 * constructed, no `error`/`close` ever fires, and none of the 10 reconnect
 * attempts ever happen — the session sits on "connecting" forever, and stays
 * there long after the server is back. Reproduced: zero sockets opened.
 *
 * A timed-out attempt therefore degrades exactly like any other failed one —
 * `null`, so `serverIsBroker` stays unlatched and the attempt falls through
 * to the same-origin `websocket` path, whose failure re-enters the normal
 * backoff and re-fetches this on the next attempt.
 *
 * Sized well above the real work (one same-origin JSON GET that reads the
 * agent's row) and well under a user's patience — the same 10s the studio's
 * gating reads use for the identical hazard.
 *
 * @internal
 */
export const CLIENT_CONFIG_ATTEMPT_TIMEOUT_MS = 10_000;

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
    const resp = await doFetch(buildAgentUrl(platformUrl, CLIENT_CONFIG_PATH).href, {
      // Without this a hung lookup wedges the session permanently — see
      // CLIENT_CONFIG_ATTEMPT_TIMEOUT_MS.
      signal: AbortSignal.timeout(CLIENT_CONFIG_ATTEMPT_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const parsed = ClientConfigResponseSchema.safeParse(await resp.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the agent's declared `name`, `greeting` and front door; any failure
 * yields the agent default (`{}`).
 *
 * **This is what a workflow app calls instead of receiving the config.**
 * `mountClient()` fetches `GET client-config` for itself before it renders the
 * default chat shell, so a voice client never has to. `mountPage()` mounts no
 * session and makes no such request — deliberately, since a page has no shell
 * to put a name in — so a page that wants the agent's own `name` or `greeting`
 * asks for them here.
 *
 * Every failure path degrades to the empty default rather than throwing: a
 * network error, a 404 from a server older than the endpoint, a malformed
 * body, and a lookup that hangs past
 * `CLIENT_CONFIG_ATTEMPT_TIMEOUT_MS` all read as "the agent declared nothing".
 * So a page may render straight from the result and never needs a `catch` —
 * treat every field as optional, because an agent that declared none is a
 * normal agent.
 *
 * @param platformUrl - The agent's base URL. On a deployed page that is the
 * page's own origin and path (`location.origin + location.pathname`); the
 * endpoint is resolved relative to it.
 * @param fetchFn - Fetch implementation, for tests and for a caller that
 * supplies its own credentials. Defaults to the global `fetch`.
 * @returns The agent's config, or `{}` when the lookup produced no answer.
 *
 * @example
 * ```tsx
 * import { fetchClientConfig, mountPage } from "@alexkroman1/aai-ui";
 *
 * const { name, greeting } = await fetchClientConfig(
 *   location.origin + location.pathname,
 * );
 *
 * function App() {
 *   return (
 *     <main>
 *       <h1>{name ?? "Workflows"}</h1>
 *       {greeting ? <p>{greeting}</p> : null}
 *     </main>
 *   );
 * }
 *
 * mountPage({ name: name ?? "Workflows", component: App });
 * ```
 *
 * @public
 */
export async function fetchClientConfig(
  platformUrl: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<ClientConfigResponse> {
  return (await loadClientConfig(platformUrl, fetchFn)) ?? AGENT_DEFAULT;
}
