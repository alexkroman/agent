// Copyright 2026 the AAI authors. MIT license.
/**
 * The service process lifecycle, shared by every entry point: bring an HTTP
 * server up, and take it down on a signal in the right order.
 *
 * Three entries need this — the agent service, the standalone studio service,
 * and the combined single-process composition — and they had three copies of
 * the boot scaffolding and two copies of the shutdown sequence. The copies had
 * already drifted: the combined shutdown lost the "timed out waiting for
 * connections" warning, so in the mode local dev and pre-split deployments run,
 * a shutdown that hung on open connections exited silently.
 *
 * What is shared is the *mechanism* — listen, log, signal handling,
 * re-entrancy, close, fallback exit. What stays per-service is the *policy*,
 * supplied as `onShutdown`. There is no session-drain wait anywhere: voice
 * sessions live in guest sandboxes that this process retires rather than
 * terminates (see teardown-sandboxes.ts), so live calls finish in the
 * guests on their own clock after the replica is gone.
 */

import type { Server as NodeHttpServer } from "node:http";
import { errorMessage } from "@alexkroman1/aai";
import { EGRESS_KEEP_ALIVE_MS } from "@alexkroman1/aai-runtime/internal";
import { serve } from "@hono/node-server";
import pTimeout from "p-timeout";
import { SHUTDOWN_CLOSE_FALLBACK_MS, SHUTDOWN_TEARDOWN_TIMEOUT_MS } from "./constants.ts";
import { endLiveStreams } from "./live-streams.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("serve");

/** The slice of a node HTTP server this module drives. Injectable for tests. */
export type ServerLike = {
  on(event: "error", cb: (err: unknown) => void): void;
  on(event: "listening", cb: () => void): void;
  close(cb?: () => void): void;
  /**
   * Node's socket reaps, set by {@link startService} — see
   * {@link HTTP_KEEP_ALIVE_TIMEOUT_MS}.
   *
   * OPTIONAL so an injected test double need not carry them, and writable
   * because Node exposes them as assignable properties rather than as `serve`
   * options: `@hono/node-server` takes `{fetch, port}` and hands back the
   * `http.Server`, which is the only place these can be set.
   */
  keepAliveTimeout?: number | undefined;
  headersTimeout?: number | undefined;
};

/**
 * How long an idle keep-alive socket is kept between requests.
 *
 * **Set at all because it was Node's 5s default, under a client that holds its
 * end for 30s** — and the shorter side decides, so the guest's
 * `EGRESS_KEEP_ALIVE_MS` was unreachable and every journal call more than 5s
 * after the previous one opened a fresh socket. Measured on this shape (6
 * sequential POSTs, client 30s): 6s apart against a 5s server is **6 TCP
 * connections**; the same run with the server above the client is **1**. A
 * durable step that takes longer than 5s is the ordinary case — an LLM call, a
 * transcription, an ffmpeg convert — so the guest→platform journal path was
 * paying that on essentially every `appendStep`.
 *
 * **DERIVED from the client's value, not restated.** The two were set
 * independently, in different packages, and nothing related them — which is the
 * whole defect: a client keep-alive is only half of one. Adding a margin here
 * means the server always reaps second, which is the direction that matters
 * (the reverse is a client reusing a socket the server is closing, whose
 * `ECONNRESET` reaches `fetch` as the bare "fetch failed" this repo has already
 * chased once).
 *
 * **What it does NOT claim.** `@modal.web_server` puts Modal's ASGI proxy in
 * front, so the guest's TLS terminates at Modal's edge and this governs the
 * proxy→Node hop — localhost, no TLS, where a socket setup is far cheaper than
 * the ~20% of wall time `_egress-fetch.ts` measured for a real handshake. So
 * this is correctness and hygiene on the half we control, not a measured
 * production win; whether Modal's proxy pools upstream at all is not knowable
 * from here.
 */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = EGRESS_KEEP_ALIVE_MS + 5000;

/**
 * Slowloris bound: how long a client may take to send COMPLETE request headers.
 *
 * Above {@link HTTP_KEEP_ALIVE_TIMEOUT_MS} deliberately — Node races the two
 * against each other, and a headers timeout at or below the keep-alive can reap
 * a socket while its next request's headers are still arriving. Still well
 * under Node's own 60s default, so raising the keep-alive did not weaken the
 * bound it shares a socket with. The BODY phase stays on Node's
 * `requestTimeout` (300s), for the reason `aai-runtime/server.ts` states one
 * package over: an upload is legitimately long-bodied and the slowloris vector
 * is the headers phase.
 */
export const HTTP_HEADERS_TIMEOUT_MS = HTTP_KEEP_ALIVE_TIMEOUT_MS + 5000;

export type ShutdownHandlerOptions = {
  /** Service-specific teardown, run before the HTTP server is closed. */
  onShutdown: () => Promise<void>;
  /** Close the HTTP server, invoking `cb` once connections have ended. */
  closeServer: (cb: () => void) => void;
  /** Injectable for tests — defaults to `process.exit`. */
  exit?: (code: number) => void;
  fallbackMs?: number;
  /**
   * Deadline for `onShutdown`. Defaults to
   * {@link SHUTDOWN_TEARDOWN_TIMEOUT_MS}; the constant carries the budget
   * arithmetic it has to cover.
   */
  teardownTimeoutMs?: number;
};

/**
 * Build the signal handler: run the service's teardown, close the server, and
 * exit — with a bounded fallback so a connection that never ends cannot hang
 * the process past the platform's stop grace period.
 *
 * Idempotent: a second SIGTERM during teardown (a platform that signals twice,
 * or an impatient operator) must not run sandbox teardown a second time.
 */
export function createShutdownHandler(opts: ShutdownHandlerOptions): () => Promise<void> {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const fallbackMs = opts.fallbackMs ?? SHUTDOWN_CLOSE_FALLBACK_MS;
  const teardownTimeoutMs = opts.teardownTimeoutMs ?? SHUTDOWN_TEARDOWN_TIMEOUT_MS;
  let running = false;

  return async () => {
    if (running) return;
    running = true;
    // FIRST, before any teardown: long-lived responses (SSE) never end on
    // their own, so `close()` below would wait out the fallback and then have
    // `process.exit` destroy them MID-CHUNK — a truncated chunked body to
    // whatever is reading, which in production is Modal's ASGI proxy (see
    // live-streams.ts). Ending them is both the fix and what lets `close()`
    // actually complete.
    //
    // Ordering is load-bearing. This ran AFTER `onShutdown()`, which spends
    // `SHUTDOWN_GRACE_MS` asleep and then awaits one drain request per
    // resident guest — seconds at best, unbounded when a guest is unreachable.
    // Modal SIGKILLs the container when its stop grace lapses, so anything
    // that slow in front of this made the graceful end contingent on sandbox
    // teardown finishing in time, and a SIGKILL truncates every open stream.
    // Ending a stream needs nothing from the teardown and costs the client one
    // reconnect, so it belongs at the very top of shutdown; the registry
    // latches closed, so streams opened during the teardown below end
    // gracefully too.
    const ended = endLiveStreams();
    if (ended > 0) log.info(`shutdown: ended ${ended} live stream(s)`);

    try {
      // BOUNDED, because the timer below cannot cover this. It is armed only
      // after `onShutdown()` settles, so for a long time the one deadline on
      // shutdown protected the fast half — waiting for connections to close —
      // and left the slow half unbounded. And the slow half is the one that
      // hangs: retiring a resident guest goes through the spawn's readiness
      // promise (120s of boot budget before SANDBOX_TEARDOWN_READY_MS capped
      // it), and the Modal control-plane calls underneath carry no timeout at
      // all. Past the container's stop grace the platform SIGKILLs, so the
      // hang was not merely slow — it was SILENT, skipping both the warning
      // below and the graceful close it guards.
      await pTimeout(opts.onShutdown(), {
        milliseconds: teardownTimeoutMs,
        message: `teardown exceeded ${teardownTimeoutMs}ms; exiting anyway`,
      });
    } catch (err: unknown) {
      // A teardown that throws — or now, one that overran — must not strand
      // the process: the platform SIGKILLs when the grace period lapses, which
      // is strictly worse than exiting with one sandbox possibly un-terminated
      // (the guest's own idle self-exit and Modal's sandbox timeout reclaim
      // it). Both outcomes take this path deliberately: there is nothing
      // different to DO about them, and one log line beats two.
      log.warn("shutdown teardown failed", { error: errorMessage(err) });
    }

    opts.closeServer(() => exit(0));
    const timer = setTimeout(() => {
      // Loud on purpose: silently exiting here is how a hung shutdown hides.
      log.warn("shutdown timed out waiting for connections to close; exiting");
      exit(0);
    }, fallbackMs);
    timer.unref?.();
  };
}

export type StartServiceOptions = {
  /** Logged on listen, e.g. "AAI agent service". */
  label: string;
  fetch: (req: Request) => Response | Promise<Response>;
  port: number;
  /** Attach WebSocket upgrade handling before the server starts listening. */
  injectWebSocket?: (server: NodeHttpServer) => void;
  onShutdown: () => Promise<void>;
  /** Injectable for tests — defaults to `@hono/node-server`'s serve. */
  serveImpl?: (opts: { fetch: StartServiceOptions["fetch"]; port: number }) => ServerLike;
};

/** Start the HTTP server and wire signal-driven shutdown. Resolves once listening. */
export async function startService(opts: StartServiceOptions): Promise<void> {
  const serveImpl = opts.serveImpl ?? (serve as unknown as NonNullable<typeof opts.serveImpl>);
  const server = serveImpl({ fetch: opts.fetch, port: opts.port });
  // BEFORE `listening`, so no connection is ever served under the defaults.
  // `@hono/node-server` takes no timeout options — it hands back the
  // `http.Server`, and these are assignable properties on it.
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  opts.injectWebSocket?.(server as unknown as NodeHttpServer);

  // Without a listener, a listen failure (e.g. EADDRINUSE) gets Node's default
  // throw-from-nowhere. Log it usefully and exit.
  server.on("error", (err: unknown) => {
    log.error("http server error", { error: errorMessage(err) });
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    server.on("listening", resolve);
  });
  log.info(`${opts.label} listening on http://localhost:${opts.port}`);

  const shutdown = createShutdownHandler({
    onShutdown: opts.onShutdown,
    closeServer: (cb) => server.close(cb),
  });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
