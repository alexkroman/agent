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
import { serve } from "@hono/node-server";
import { SHUTDOWN_CLOSE_FALLBACK_MS } from "./constants.ts";
import { endLiveStreams } from "./live-streams.ts";

/** The slice of a node HTTP server this module drives. Injectable for tests. */
export type ServerLike = {
  on(event: "error", cb: (err: unknown) => void): void;
  on(event: "listening", cb: () => void): void;
  close(cb?: () => void): void;
};

export type ShutdownHandlerOptions = {
  /** Service-specific teardown, run before the HTTP server is closed. */
  onShutdown: () => Promise<void>;
  /** Close the HTTP server, invoking `cb` once connections have ended. */
  closeServer: (cb: () => void) => void;
  /** Injectable for tests — defaults to `process.exit`. */
  exit?: (code: number) => void;
  fallbackMs?: number;
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
  let running = false;

  return async () => {
    if (running) return;
    running = true;
    try {
      await opts.onShutdown();
    } catch (err: unknown) {
      // A teardown that throws must not strand the process: the platform
      // SIGKILLs when the grace period lapses, which is strictly worse than
      // exiting with one sandbox possibly un-terminated (the guest's own
      // orphan timeout reclaims it).
      console.warn("Shutdown teardown failed:", errorMessage(err));
    }
    // Long-lived responses (SSE) never end on their own, so `close()` below
    // would wait out the fallback and then have `process.exit` destroy them
    // MID-CHUNK — a truncated chunked body to whatever is reading, which in
    // production is Modal's ASGI proxy (see live-streams.ts). Ending them
    // first is both the fix and what lets `close()` actually complete.
    const ended = endLiveStreams();
    if (ended > 0) console.info(`Shutdown: ended ${ended} live stream(s)`);

    opts.closeServer(() => exit(0));
    const timer = setTimeout(() => {
      // Loud on purpose: silently exiting here is how a hung shutdown hides.
      console.warn("Shutdown timed out waiting for connections to close; exiting");
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
  opts.injectWebSocket?.(server as unknown as NodeHttpServer);

  // Without a listener, a listen failure (e.g. EADDRINUSE) gets Node's default
  // throw-from-nowhere. Log it usefully and exit.
  server.on("error", (err: unknown) => {
    console.error("HTTP server error:", err);
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    server.on("listening", resolve);
  });
  console.info(`${opts.label} listening on http://localhost:${opts.port}`);

  const shutdown = createShutdownHandler({
    onShutdown: opts.onShutdown,
    closeServer: (cb) => server.close(cb),
  });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
