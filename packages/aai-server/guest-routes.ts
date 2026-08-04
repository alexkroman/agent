// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest harness's HTTP/WebSocket surface, spelled once.
 *
 * Each backend used to hardcode `/ws` and `/websocket` when building its URLs,
 * and `WarmHarness.sessionUrl` was a bare string that the studio package then
 * reverse-engineered — swapping the scheme and overwriting the pathname — to
 * reach a third surface it was never handed. Renaming or adding a guest route
 * therefore meant editing both backends plus URL surgery in another package,
 * and a mismatch surfaces only as a 404 the client reads as a dead sandbox,
 * re-brokering against it forever with no server-side error.
 *
 * Backends now report the guest's ORIGIN and everything derives routes from
 * these constants.
 */

/** Paths the guest harness serves. Mirrors aai-guest's own dispatch. */
export const GUEST_ROUTES = {
  /** Host↔guest JSON-RPC control channel (bearer-gated; studio mode only). */
  control: "/ws",
  /** PUBLIC client voice sessions, connected directly by browsers. */
  session: "/websocket",
  /** PUBLIC studio coding-agent chat (SSE), bearer-gated by the caller's key. */
  studioChat: "/studio/chat",
  /** PUBLIC readiness probe (the SDK server's own /health). */
  health: "/health",
  /** PUBLIC pre-connection client config (the SDK server's own route). */
  clientConfig: "/client-config",
  /** Agent-mode management surface (bearer-gated): session count + drain. */
  manageStatus: "/manage/status",
  manageDrain: "/manage/drain",
} as const;

export type GuestRoute = (typeof GUEST_ROUTES)[keyof typeof GUEST_ROUTES];

/** A guest WebSocket URL — `ws(s)://host:port/<route>`. */
export function guestWsUrl(origin: string, route: GuestRoute): string {
  return `${origin}${route}`;
}

/**
 * A guest HTTP URL for the same origin: the harness serves HTTP and
 * WebSocket on one port, so this only swaps the scheme (`ws`→`http`,
 * `wss`→`https`).
 */
export function guestHttpUrl(origin: string, route: GuestRoute): string {
  const url = new URL(`${origin}${route}`);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  return url.toString();
}
