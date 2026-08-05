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
 * Latched by {@link endLiveStreams}: once shutdown has drained the registry,
 * nothing will ever drain it again, so a stream registered afterwards would be
 * held open until the process exit destroys it — the exact truncation this
 * module exists to prevent, reintroduced for the narrow set of clients that
 * reconnect during shutdown. That set is not narrow in practice: the studio
 * client's first reconnect backoff is 3s and the agent service's shutdown
 * spends `SHUTDOWN_GRACE_MS` (3s) still serving on purpose, so a resubscribe
 * landing here mid-shutdown is the MODAL case, not the rare one.
 */
let closed = false;

/**
 * Register a live response's ender. Returns the deregistration, which the
 * caller MUST run when the stream ends on its own — a registry that only
 * grows is a leak, and worse, would let shutdown call an ender for a response
 * that has already completed.
 *
 * Once shutdown has run, `end` is invoked SYNCHRONOUSLY instead of registered:
 * a stream that arrives during shutdown ends itself the same graceful way one
 * caught by shutdown does (the terminating chunk goes out, the client backs
 * off and lands on a live replica) rather than waiting for a drain that has
 * already happened.
 */
export function registerLiveStream(end: EndStream): () => void {
  if (closed) {
    end();
    return () => undefined;
  }
  live.add(end);
  return () => live.delete(end);
}

/**
 * End every registered response, and latch the registry closed so streams
 * opened after this point end themselves (see {@link closed}). Enders
 * deregister themselves as their streams settle, so iterate a copy.
 *
 * Returns the count for the shutdown log: "how many live streams did this
 * replica cut" is the number you want when a client reports a reconnect
 * storm, and it is invisible otherwise.
 */
export function endLiveStreams(): number {
  closed = true;
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

/**
 * Test seam: drop the shutdown latch. A process shuts down once, so nothing in
 * production resets this — but a suite that exercises shutdown has to hand the
 * next test a registry that still accepts registrations.
 */
export function resetLiveStreams(): void {
  live.clear();
  closed = false;
}
