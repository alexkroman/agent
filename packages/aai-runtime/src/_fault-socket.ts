// Copyright 2026 the AAI authors. MIT license.
/**
 * Socket fault mode: a TCP proxy that SEVERS live connections, so a test can
 * prove a session continues across a disconnect.
 *
 * ## Why a proxy and not a server-side kill switch
 *
 * Only the server holds the session's WebSocket, so the obvious shape is an
 * env-gated `ws.close()` inside `createServer` — a fault injector living in
 * production code, able to fire in production. `aai-cli/_fault-mode.ts` (the
 * process-restart mode) refuses that on principle and this follows it: a proxy in
 * front of the server is test-only by construction.
 *
 * It is also the more FAITHFUL of the two. A clean WebSocket close is a
 * different event from a severed TCP connection, and the client is documented to
 * treat them differently — aai-ui does not reconnect after a user disconnect,
 * while an abrupt drop re-enters partysocket's backoff. Destroying the socket
 * reproduces the case that actually happens in the wild: a load balancer idle
 * timeout, a laptop lid, a Modal sandbox being replaced, a phone changing
 * networks. `severAll()` therefore DESTROYS; it never sends a close frame,
 * which it could not do anyway without speaking WebSocket.
 *
 * ## What a test built on this can and cannot claim
 *
 * The advertised contract for a reconnect inside {@link SESSION_RESUME_GRACE_MS}
 * is: the same `?sessionId=` resumes that session, the greeting is suppressed
 * (`skipGreeting`), server-side history is kept, and its slot values are still
 * there — the state sweep waits the grace window out before dropping them.
 *
 * What this mode reaches is the PROCESS-LOCAL half of that, and the boundary is
 * one of SETUP rather than of architecture. The session and sink maps really are
 * per process, so a severed socket is the most a proxy in front of one server can
 * simulate. A slot's VALUE is a different matter: it lives in the session-state
 * store (`session-state-store.ts`), whose Postgres backend commits at the end of
 * every tool call, so it outlives the process that wrote it — which is what lets
 * a redeploy, a crash or `handoverSlot`'s blue-green swap hand a reconnecting
 * caller their cart back. `aai-server/session-state.scenario.test.ts` proves that
 * against a real database, starting with the case named "a slot's value survives
 * a new process".
 *
 * So the honest split between the two fault modes is which FAILURE each one
 * injects — a severed connection here, a hard-killed process in
 * `aai-cli/_fault-mode.ts` — and not a claim that state cannot survive one of
 * them. This doc said the opposite for a long time ("a voice session does not
 * because its state is in a Map"), which stopped being true when the store
 * replaced the runtime's `stateMap` and was the reason not to go looking.
 */

import net from "node:net";
import { invariant } from "@alexkroman1/aai/internal";

/** One connection the proxy is relaying, with the two sockets it owns. */
type Relay = { client: net.Socket; upstream: net.Socket };

/**
 * When a connection severs itself, without a test having to ask.
 *
 * Deterministic on purpose, exactly as the process-restart mode is: `bytes` and
 * `connections` are counts, and `ms` is measured from the connection opening
 * rather than from a suite starting, so the Nth connection is cut at the same
 * point on every machine. There is no seed and no PRNG here either — see that
 * module's doc for why a fault mode that grew one would be the seventh.
 */
export type SeverAfter = {
  /** Sever once this many bytes have arrived FROM the client on a connection. */
  bytesFromClient?: number;
  /** Sever this long after the connection opens. */
  ms?: number;
};

export type SeveringProxy = {
  /** The port to point a client at, in place of the server's own. */
  port: number;
  /** Sever every live connection. Resolves how many were cut. */
  severAll: () => number;
  /** Connections currently relayed. */
  live: () => number;
  /** Connections severed so far, across the proxy's life. */
  severed: () => number;
  close: () => Promise<void>;
};

/**
 * Relay `127.0.0.1:<port>` to `target`, with the ability to cut connections.
 *
 * Binds port 0 and reports what it got: a fixed port would collide with the
 * suites this runs beside, and nothing about a proxy needs a stable one — a test
 * reads `proxy.port` and builds its URL from it.
 */
export async function createSeveringProxy(opts: {
  target: number;
  severAfter?: SeverAfter;
}): Promise<SeveringProxy> {
  const relays = new Set<Relay>();
  let severedCount = 0;

  /** Destroy both halves and forget the relay. Idempotent per relay. */
  const sever = (relay: Relay): void => {
    if (!relays.delete(relay)) return;
    severedCount += 1;
    // `destroy()`, not `end()`: an orderly FIN is a clean close, which is the
    // event this mode exists NOT to produce.
    relay.client.destroy();
    relay.upstream.destroy();
  };

  const server = net.createServer((client) => {
    const upstream = net.connect(opts.target, "127.0.0.1");
    const relay: Relay = { client, upstream };
    relays.add(relay);

    let fromClient = 0;
    const budget = opts.severAfter?.bytesFromClient;
    client.on("data", (chunk: Buffer) => {
      fromClient += chunk.byteLength;
      if (budget !== undefined && fromClient >= budget) sever(relay);
    });

    const after = opts.severAfter?.ms;
    if (after !== undefined) {
      const timer = setTimeout(() => sever(relay), after);
      timer.unref();
      client.on("close", () => clearTimeout(timer));
    }

    // Both directions, and either end closing takes the pair with it — a relay
    // that keeps one half open after the other died leaks a socket per fault.
    client.pipe(upstream);
    upstream.pipe(client);
    for (const socket of [client, upstream]) {
      socket.on("error", () => sever(relay));
      socket.on("close", () => {
        // Not a fault: the peer closed on its own, so this must not be counted
        // as a sever or the oracle would read a clean hangup as an injection.
        if (relays.delete(relay)) {
          relay.client.destroy();
          relay.upstream.destroy();
        }
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  // A `net.Server` this module just listened on at `127.0.0.1:0` reports an
  // `AddressInfo` — the string form is a pipe/UDS and the null one is "not
  // listening", and this call chose neither. Stated rather than validated, so
  // the narrowing below is the check rather than a second reading of it.
  invariant(address !== null && typeof address !== "string", "fault.proxy.bound", () => ({
    address,
  }));

  return {
    port: address.port,
    severAll: () => {
      const cut = relays.size;
      for (const relay of [...relays]) sever(relay);
      return cut;
    },
    live: () => relays.size,
    severed: () => severedCount,
    close: async () => {
      for (const relay of [...relays]) {
        relays.delete(relay);
        relay.client.destroy();
        relay.upstream.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
