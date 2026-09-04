// Copyright 2026 the AAI authors. MIT license.
/**
 * WHICH platform socket a call should use, and who owns its lifetime.
 *
 * Split from `platform-socket.ts` because they answer different questions and
 * the file was two lines under the 500-line cap. That module is the MECHANISM —
 * frames, correlation, the heartbeat, the reconnect, the refusal taxonomy — and
 * this one is the POLICY: one socket per process per base, opened by the one
 * composition root that has a lifetime to hang it on, consulted by
 * `platform-rpc.ts` on every call.
 *
 * @module platform-socket-registry
 */

import type { PlatformEndpoint } from "./platform-endpoint.ts";
import {
  type CreatePlatformWebSocket,
  createPlatformSocket,
  type PlatformSocket,
} from "./platform-socket.ts";
import type { Logger } from "./runtime-config.ts";

/**
 * Every socket this process has opened, keyed by the base it dials.
 *
 * A registry rather than a value threaded through five clients, and for the
 * reason `_egress-fetch.ts` gives for its pools: the clients are handed
 * `{base, token}` by four different composition sites, none of which owns a
 * lifetime, and the socket has to be ONE for the process or the Modal input
 * accounting above is wrong. Keyed by base so a spec — or a host serving two
 * agents — cannot silently share one.
 */
const sockets = new Map<string, PlatformSocket>();

/**
 * Open this process's socket to `base`, if it has not already.
 *
 * Called from `installWorkflowSupport`, which is the one composition root that
 * runs once per `AgentServer` and already owns the egress pools' lifetime.
 * Calling it anywhere else risks a socket nobody closes — and calling it from a
 * CLIENT factory would open one per client, which is what the registry exists to
 * prevent.
 *
 * @internal
 */
export function ensurePlatformSocket(
  opts: PlatformEndpoint,
  extra: {
    logger?: Logger | undefined;
    create?: CreatePlatformWebSocket | undefined;
    /**
     * An already-built socket, for a spec testing what CONSULTS this registry
     * rather than what a socket does.
     *
     * `platform-rpc.test.ts` is the caller: its subject is the transport CHOICE —
     * prefer a socket, fall back on a refusal, never retry a written call — and
     * driving a fake peer through a handshake to state that would be asserting on
     * this module twice. `platform-socket.test.ts` is where the socket itself is
     * driven, through `create`.
     */
    socket?: PlatformSocket | undefined;
  } = {},
): PlatformSocket {
  const existing = sockets.get(opts.base);
  if (existing !== undefined) return existing;
  const socket =
    extra.socket ??
    createPlatformSocket({
      base: opts.base,
      token: opts.token,
      ...extra,
    });
  sockets.set(opts.base, socket);
  return socket;
}

/**
 * The open socket for this endpoint, or `undefined` when a caller should use HTTP.
 *
 * Keyed on the registry alone and NOT on whether the caller declared an
 * `opts.fetch`. That was the first shape and it is wrong in both directions: it
 * makes the HTTP seam mean two things, and — the reason it did not survive
 * review — it makes the FALLBACK unreachable from a spec, since a spec that
 * declares a fetch to observe the fallback would thereby switch the socket off.
 * The registry is empty until `ensurePlatformSocket` is called, which only
 * `installWorkflowSupport` does, so a unit test opens nothing by default and a
 * spec that wants both transports registers a fake socket and declares a fetch.
 *
 * @internal
 */
export function platformSocketFor(opts: PlatformEndpoint): PlatformSocket | undefined {
  const socket = sockets.get(opts.base);
  return socket?.isOpen() === true ? socket : undefined;
}

/**
 * Close every socket this process opened.
 *
 * Beside `closeEgressFetch()` in `installWorkflowSupport`'s `close()`, and for
 * the same reason: a socket an old server left connected would go on holding one
 * of the platform's Modal inputs.
 *
 * **It closes ALL of them, not the caller's own**, which differs from
 * `closeEgressFetch` in one case: two overlapping `AgentServer`s in one process
 * (the second built before the first is closed) would share a socket, and the
 * first's close would take it away from the second — which then stays on the
 * HTTP fallback, since nothing re-opens outside `ensurePlatformSocket`.
 *
 * Not refcounted, because that overlap is unreachable where a socket exists: the
 * registry is only ever filled when `platformGuestOptions()` answers, i.e. in a
 * DEPLOYED guest, and a guest process builds one server for one agent. `aai dev`
 * and a self-hosted `createServer` — the compositions that really do rebuild a
 * server in place — have neither platform key and open nothing. If that stops
 * being true, a handle per holder is the fix rather than a lazier `platformSocketFor`:
 * re-opening from the read path is what would let a unit test dial.
 *
 * @internal
 */
export function closePlatformSockets(): void {
  const held = [...sockets.values()];
  sockets.clear();
  for (const socket of held) socket.close();
}
