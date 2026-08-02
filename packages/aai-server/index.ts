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

import { DEFAULT_PORT } from "./constants.ts";
import { createOrchestrator, type OrchestratorOpts } from "./orchestrator.ts";
import { drainActiveSessions, startService } from "./serve-lifecycle.ts";
import {
  assertSandboxBackendOrWarn,
  buildServiceConfig,
  installProcessSafetyNets,
} from "./service-config.ts";
import { teardownSandboxes } from "./teardown-sandboxes.ts";

async function main(): Promise<void> {
  installProcessSafetyNets();

  const env = process.env;
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

  await startService({
    label: "AAI agent service",
    fetch: app.fetch,
    port,
    injectWebSocket,
    onShutdown: async () => {
      // Stop taking work before waiting for it to finish, then let live calls
      // end on their own. A voice session is a long-lived socket, so closing
      // them immediately (which this used to do) cut every conversation in
      // flight on every deploy — both strategies replace all machines, so that
      // was every active call, mid-sentence.
      draining = true;
      await drainActiveSessions({ activeCount: activeSessionCount, env });

      console.info("Shutting down...");
      // Close client WebSockets: closing the HTTP server only waits for
      // connections to end, it never ends them, so open sessions would ride
      // out the whole fallback timeout on every SIGTERM under load.
      closeActiveSockets();
      await teardownSandboxes({ slots: opts.slots, pool: opts.pool });
    },
  });
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
