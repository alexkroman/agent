// Copyright 2025 the AAI authors. MIT license.
/**
 * Node.js entry point for the AAI AGENT service: voice sessions (WebSocket),
 * the platform API (deploy/delete/secret/storage), and — when
 * `STUDIO_UPSTREAM_URL` is set — a reverse proxy to the studio service so
 * browsers see one public origin. Without an upstream the studio surface is
 * simply not served here.
 *
 * The studio service and the combined single-process composition (local
 * dev, pre-split deployments) live in the aai-studio-server package.
 */

import { serve } from "@hono/node-server";
import { assertDevKeys, resolveDrainMs } from "./_boot.ts";
import { waitForIdle } from "./_drain.ts";
import { DEFAULT_PORT } from "./constants.ts";
import { createOrchestrator, type OrchestratorOpts } from "./orchestrator.ts";
import {
  assertSandboxBackendOrWarn,
  buildServiceConfig,
  installProcessSafetyNets,
} from "./service-config.ts";

async function main(): Promise<void> {
  installProcessSafetyNets();

  const env = process.env;
  assertDevKeys(env);
  const port = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);

  // Flipped by `shutdown()` before anything is torn down: it fails /health
  // so the platform's proxy stops routing here, and refuses new WebSocket
  // upgrades. Both are needed for the drain below to converge — otherwise the
  // replica keeps accepting the sessions it is waiting to finish.
  let draining = false;
  const opts: OrchestratorOpts = {
    ...buildServiceConfig(env),
    isDraining: () => draining,
    ...(env.STUDIO_UPSTREAM_URL && { studioUpstream: env.STUDIO_UPSTREAM_URL }),
  };

  assertSandboxBackendOrWarn(env);

  const { app, injectWebSocket, closeActiveSockets, activeSessionCount } = createOrchestrator(opts);
  const nodeServer = serve({ fetch: app.fetch, port });
  injectWebSocket(nodeServer as import("node:http").Server);

  // Without a listener, a listen failure (e.g. EADDRINUSE) gets Node's
  // default throw-from-nowhere. Log it usefully and exit.
  nodeServer.on("error", (err) => {
    console.error("HTTP server error:", err);
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    nodeServer.on("listening", resolve);
  });

  console.info(`AAI agent service listening on http://localhost:${port}`);

  let shuttingDown = false;
  async function shutdown() {
    // Re-entrancy guard: a second SIGTERM/SIGINT during teardown must not
    // run sandbox shutdown twice.
    if (shuttingDown) return;
    shuttingDown = true;

    // Stop taking work before waiting for it to finish, then let live calls
    // end on their own. A voice session is a long-lived socket, so closing
    // them immediately (which this used to do) cut every conversation in
    // flight on every deploy — both strategies replace all machines, so that
    // was every active call, mid-sentence.
    draining = true;
    const active = activeSessionCount();
    const drainMs = resolveDrainMs(env.SHUTDOWN_DRAIN_MS);
    console.info("Draining active sessions...", { active, drainMs });
    const { drained, remaining } = await waitForIdle({
      activeCount: activeSessionCount,
      timeoutMs: drainMs,
    });
    if (!drained) {
      // Deliberately loud: this is a call that got cut, and the deadline is
      // only correct if it is rarely hit. The platform SIGKILLs when the stop
      // grace period lapses, so waiting past it is not an option.
      console.warn("Drain deadline reached; closing sessions still in flight", { remaining });
    }

    console.info("Shutting down...");
    // Close client WebSockets: `nodeServer.close()` only waits for
    // connections to end, it never ends them, so open sessions would ride
    // out the whole fallback timeout on every SIGTERM under load.
    closeActiveSockets();
    const stops = [...opts.slots.values()].map((slot) => slot.sandbox?.shutdown()).filter(Boolean);
    if (opts.pool) stops.push(opts.pool.shutdown());
    const results = await Promise.allSettled(stops);
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("Sandbox termination failed:", r.reason);
      }
    }
    nodeServer.close(() => process.exit(0));
    // Sandboxes are already down by here; a straggling connection is not a
    // failed shutdown, so the fallback exits 0 (it used to exit 1, flagging
    // every busy SIGTERM as a crash).
    setTimeout(() => {
      console.warn("Shutdown timed out waiting for connections to close; exiting");
      process.exit(0);
    }, 3000).unref();
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
