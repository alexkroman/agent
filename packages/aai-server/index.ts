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
  // so the platform's proxy stops routing here — needed for the drain below
  // to converge, otherwise the replica keeps brokering new sessions onto the
  // guests it is waiting to finish.
  let draining = false;
  const config = buildServiceConfig(env);
  const opts: OrchestratorOpts = {
    ...config,
    isDraining: () => draining,
    ...(env.STUDIO_UPSTREAM_URL && { studioUpstream: env.STUDIO_UPSTREAM_URL }),
  };

  assertSandboxBackendOrWarn(env);

  const { app, injectWebSocket } = createOrchestrator(opts);

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
      // The count is the GUESTS' sessions: browser sessions dial the sandbox
      // tunnel directly and this process terminates no sessions of its own
      // (host mode, the last in-process session surface, was removed), so a
      // socket count here would always read 0 while calls were live — the
      // drain would return at once and teardown would cut them anyway.
      draining = true;
      await drainActiveSessions({
        activeCount: () => liveGuestSessions(opts.slots),
        // Each poll is an RPC fan-out across the replica's guests.
        pollMs: DRAIN_GUEST_POLL_MS,
        env,
      });

      console.info("Shutting down...");
      await teardownSandboxes({ slots: opts.slots });
      await config.events.close();
    },
  });
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
