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
import { DEFAULT_PORT } from "./constants.ts";
import { createOrchestrator, type OrchestratorOpts } from "./orchestrator.ts";
import { startService } from "./serve-lifecycle.ts";
import {
  assertSandboxBackendOrWarn,
  buildServiceConfig,
  installProcessSafetyNets,
} from "./service-config.ts";
import { teardownSandboxes } from "./teardown-sandboxes.ts";

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
      // Stop taking new work, then RETIRE the guests rather than wait on or
      // terminate them: sessions dial the sandbox tunnel directly and the
      // guests have no dependency on this process, so live calls finish in
      // the guests on their own clock (see teardown-sandboxes.ts). The old
      // count-and-wait drain here could only ever delay the exit — and past
      // its budget it cut the very calls it existed to protect.
      draining = true;
      console.info("Shutting down (retiring guests)...");
      await teardownSandboxes({ slots: opts.slots });
      await config.events.close();
    },
  });
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
