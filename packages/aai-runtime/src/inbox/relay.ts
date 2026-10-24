// Copyright 2026 the AAI authors. MIT license.
/**
 * Reaching a client whose `/inbox` socket another PROCESS holds.
 *
 * `stepNotifyClient` delivers through the notifier this process published, and
 * a workflow step runs wherever the engine runs it. With one process that is
 * where the socket is. Under `aai start --workers` the client's sockets live on
 * the worker its id routes to, and a step on any other worker would answer
 * `"offline"` and retry until a retry happened to land there.
 *
 * So a HOST that spreads clients over processes installs a relay: for a client
 * this process does not own it answers a notifier that forwards the notice to
 * the owner (`aai-cli`'s workers do it over IPC), and the owner delivers it
 * with {@link notifyClientHere} — the local inbox, never the relay again. With
 * no relay installed every client is local, which is every host but that one.
 *
 * @module
 */
import type { ClientNotifier } from "@alexkroman1/aai/host-internal";

/** How a host forwards a notice for a client held by another process. @internal */
export interface ClientNotifyRelay {
  /** A notifier that reaches `clientId`'s owner, or `undefined` when this process owns it. */
  forward(clientId: string): ClientNotifier | undefined;
}

let relay: ClientNotifyRelay | undefined;
let local: ClientNotifier | undefined;

/** Install (or with `undefined`, remove) this process's relay. @internal */
export function setClientNotifyRelay(next: ClientNotifyRelay | undefined): void {
  relay = next;
}

/**
 * The notifier to publish for a server whose own inbox is `inbox`: local
 * clients go to it, others through the relay. Records `inbox` as this
 * process's local delivery for {@link notifyClientHere}.
 *
 * @internal
 */
export function routedClientNotifier(inbox: ClientNotifier): ClientNotifier {
  local = inbox;
  return (clientId, notice, options) =>
    (relay?.forward(clientId) ?? inbox)(clientId, notice, options);
}

/**
 * Deliver to a client held by THIS process — the owner's half of a relayed
 * notice. `"offline"` when no server here has published an inbox.
 *
 * @internal
 */
export const notifyClientHere: ClientNotifier = (clientId, notice, options) =>
  local ? local(clientId, notice, options) : Promise.resolve("offline");
