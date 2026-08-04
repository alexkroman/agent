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

import { resolvePort } from "./_boot.ts";
import { DEFAULT_PORT, DRAIN_GUEST_POLL_MS } from "./constants.ts";
import { createOrchestrator, type OrchestratorOpts } from "./orchestrator.ts";
import { drainActiveSessions, startService } from "./serve-lifecycle.ts";
import {
  assertSandboxBackendOrWarn,
  buildServiceConfig,
  installProcessSafetyNets,
} from "./service-config.ts";
import { liveGuestSessions, teardownSandboxes } from "./teardown-sandboxes.ts";

async function main(): Promise<void> {
  installProcessSafetyNets();

  const env = process.env;
  const port = resolvePort(env.PORT, DEFAULT_PORT);

  // Flipped by `shutdown()` before anything is torn down: it fails /health
  // so the platform's proxy stops routing here, and refuses new WebSocket
  // upgrades. Both are needed for the drain below to converge — otherwise the
  // replica keeps accepting the sessions it is waiting to finish.
  let draining = false;
  const config = buildServiceConfig(env);
  const opts: OrchestratorOpts = {
    ...config,
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
      //
      // The count must include the GUESTS' sessions, not just this process's
      // sockets: browser sessions dial the sandbox tunnel directly, so
      // `activeSessionCount` (wss.clients.size) is blind to them and reported
      // 0 on every scale-in while calls were live — the drain returned at once
      // and teardown cut them anyway, which is the exact failure the paragraph
      // above describes, reintroduced when sessions moved into the guests.
      draining = true;
      await drainActiveSessions({
        activeCount: async () => activeSessionCount() + (await liveGuestSessions(opts.slots)),
        // Each poll is an RPC fan-out across the replica's guests.
        pollMs: DRAIN_GUEST_POLL_MS,
        env,
      });

      console.info("Shutting down...");
      // Close client WebSockets: closing the HTTP server only waits for
      // connections to end, it never ends them, so open sessions would ride
      // out the whole fallback timeout on every SIGTERM under load.
      closeActiveSockets();
      await teardownSandboxes({ slots: opts.slots, pool: opts.pool });
      await config.events.close();
    },
  });
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
