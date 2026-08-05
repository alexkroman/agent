// Copyright 2026 the AAI authors. MIT license.
/**
 * A registry of long-lived HTTP responses (the studio's SSE event streams,
 * and the agent service's proxied passthroughs of them) so shutdown can END
 * them instead of having the process exit destroy them.
 *
 * Why this exists. `server.close()` waits for open connections, and an SSE
 * stream never ends on its own, so every shutdown ran out the fallback timer
 * and called `process.exit(0)` — which destroys the sockets mid-body. A
 * chunked response cut off before its terminating `0\r\n\r\n` is a protocol
 * error to whatever is reading it, and in production that reader is Modal's
 * in-container ASGI proxy, which surfaced it as a recurring
 *
 *   ClientPayloadError: Response payload is not completed:
 *     <TransferEncodingError: 400, 'Not enough data to satisfy transfer
 *      length header.'>
 *
 * on `GET /studio/projects/<x>/events`, logged as an unretrieved task
 * exception with no clue that a replica scale-in caused it. Ending the stream
 * instead lets the writer close normally (the terminating chunk goes out, the
 * client sees a clean end and resubscribes with its existing backoff) — and,
 * because nothing is holding the connection open anymore, `server.close()`
 * can finally complete, so shutdown stops hitting the fallback timer at all.
 *
 * Process-global on purpose: it is keyed to the process's lifetime, there is
 * exactly one HTTP server per process, and threading a registry from the
 * service entry down through the proxy handler and every SSE route would put
 * a parameter on a dozen signatures to express "the process is going away".
 */

/** Ends one live response. Must be idempotent — shutdown may race a natural end. */
type EndStream = () => void;

const live = new Set<EndStream>();

/**
 * Register a live response's ender. Returns the deregistration, which the
 * caller MUST run when the stream ends on its own — a registry that only
 * grows is a leak, and worse, would let shutdown call an ender for a response
 * that has already completed.
 */
export function registerLiveStream(end: EndStream): () => void {
  live.add(end);
  return () => live.delete(end);
}

/**
 * End every registered response. Enders deregister themselves as their
 * streams settle, so iterate a copy.
 *
 * Returns the count for the shutdown log: "how many live streams did this
 * replica cut" is the number you want when a client reports a reconnect
 * storm, and it is invisible otherwise.
 */
export function endLiveStreams(): number {
  const enders = [...live];
  live.clear();
  for (const end of enders) {
    try {
      end();
    } catch {
      // A stream that cannot be ended cleanly is exactly the case the
      // fallback exit still covers; never let it block the others.
    }
  }
  return enders.length;
}

/** Test seam: number of registered streams. */
export function liveStreamCount(): number {
  return live.size;
}
