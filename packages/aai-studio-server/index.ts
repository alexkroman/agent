// Copyright 2026 the AAI authors. MIT license.
/**
 * Node.js entry point for the STUDIO service — and for the combined
 * single-process composition that local dev and pre-split deployments run.
 *
 * `AAI_SERVICE` selects the surface:
 * - `combined` (default) — one process serving both apps behind one fetch
 *   dispatcher: studio paths (`/`, `/favicon.ico`, `/studio*`,
 *   `/studio-assets/*`) go to the studio app, everything else (including
 *   `/health` and the WebSocket upgrades) to the agent orchestrator. Both
 *   apps share one ServiceConfig, so they also share the slot cache, warm
 *   pool, and stores — exactly the pre-split behavior.
 * - `studio` — the standalone studio service: no voice sessions, no
 *   WebSocket upgrades; chat turns are bounded HTTP/SSE requests, so
 *   shutdown is flip-health-and-close rather than a session drain.
 *
 * The agent-only service is the aai-server package's own entry.
 */

import { serve } from "@hono/node-server";
import { DEFAULT_PORT } from "aai-server/constants";
import { createOrchestrator } from "aai-server/orchestrator";
import { assertDevKeys, resolveDrainMs, waitForIdle } from "aai-server/platform-barrel";
import {
  assertSandboxBackendOrWarn,
  buildServiceConfig,
  installProcessSafetyNets,
  type ServiceConfig,
} from "aai-server/service-config";
import { isStudioPath } from "aai-server/studio-proxy";
import { createStudioApp, type StudioAppOpts } from "./studio-app.ts";
import {
  CHAT_RATE_LIMIT,
  createPgRateLimiter,
  PROJECT_CREATE_RATE_LIMIT,
  type StudioRateLimiters,
} from "./studio-rate-limit.ts";

function resolveServiceMode(env: NodeJS.ProcessEnv): "combined" | "studio" {
  const raw = env.AAI_SERVICE ?? "combined";
  if (raw === "combined" || raw === "studio") return raw;
  throw new Error(
    `Invalid AAI_SERVICE "${raw}" for aai-studio-server — expected combined | studio ` +
      "(the agent service is the aai-server package's entry)",
  );
}

/** Postgres rate limiters when the platform database is configured; else memory defaults apply. */
function buildRateLimiters(base: ServiceConfig): StudioRateLimiters | undefined {
  if (!base.sql) return;
  return {
    chat: createPgRateLimiter(base.sql, { name: "studio-chat", ...CHAT_RATE_LIMIT }),
    projectCreate: createPgRateLimiter(base.sql, {
      name: "studio-project-create",
      ...PROJECT_CREATE_RATE_LIMIT,
    }),
  };
}

function studioAppOpts(base: ServiceConfig, isDraining: () => boolean): StudioAppOpts {
  const rateLimiters = buildRateLimiters(base);
  return {
    store: base.store,
    workspaces: base.workspaces,
    chats: base.chats,
    ...(base.secrets && { secrets: base.secrets }),
    ...(base.appDb && { appDb: base.appDb }),
    ...(base.slugLock && { slugLock: base.slugLock }),
    ...(base.slugEpochs && { slugEpochs: base.slugEpochs }),
    ...(rateLimiters && { studioRateLimiters: rateLimiters }),
    ...(base.pool && { pool: base.pool }),
    isDraining,
  };
}

// The studio-surface predicate lives beside the proxy in aai-server —
// one definition for the split-mode proxy and this combined dispatcher.

async function main(): Promise<void> {
  installProcessSafetyNets();

  const env = process.env;
  assertDevKeys(env);
  const port = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);
  const mode = resolveServiceMode(env);

  let draining = false;
  const base = buildServiceConfig(env);
  assertSandboxBackendOrWarn(env);

  const { app: studioApp } = createStudioApp(studioAppOpts(base, () => draining));

  if (mode === "studio") {
    const nodeServer = serve({ fetch: studioApp.fetch, port });
    nodeServer.on("error", (err) => {
      console.error("HTTP server error:", err);
      process.exit(1);
    });
    await new Promise<void>((resolve) => {
      nodeServer.on("listening", resolve);
    });
    console.info(`AAI studio service listening on http://localhost:${port}`);
    let stopping = false;
    const stopStudio = async () => {
      if (stopping) return;
      stopping = true;
      draining = true;
      console.info("Studio service shutting down...");
      if (base.pool) await base.pool.shutdown().catch(() => undefined);
      nodeServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on("SIGINT", () => void stopStudio());
    process.on("SIGTERM", () => void stopStudio());
    return;
  }

  // Combined: both apps in one process, dispatched by path. Each app carries
  // its own bindings via its wrapped fetch, so no route mounting (which
  // would bypass the studio app's bindings injection) is involved.
  const orchestrator = createOrchestrator({ ...base, isDraining: () => draining });
  const combinedFetch = (req: Request): Response | Promise<Response> =>
    isStudioPath(new URL(req.url).pathname) ? studioApp.fetch(req) : orchestrator.app.fetch(req);

  const nodeServer = serve({ fetch: combinedFetch, port });
  orchestrator.injectWebSocket(nodeServer as import("node:http").Server);
  nodeServer.on("error", (err) => {
    console.error("HTTP server error:", err);
    process.exit(1);
  });
  await new Promise<void>((resolve) => {
    nodeServer.on("listening", resolve);
  });
  console.info(`AAI server (combined) listening on http://localhost:${port}`);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    // Same drain posture as the agent service's entry: stop taking work,
    // let live voice sessions end on their own, then tear down.
    draining = true;
    const drainMs = resolveDrainMs(env.SHUTDOWN_DRAIN_MS);
    console.info("Draining active sessions...", {
      active: orchestrator.activeSessionCount(),
      drainMs,
    });
    const { drained, remaining } = await waitForIdle({
      activeCount: orchestrator.activeSessionCount,
      timeoutMs: drainMs,
    });
    if (!drained) {
      console.warn("Drain deadline reached; closing sessions still in flight", { remaining });
    }
    console.info("Shutting down...");
    orchestrator.closeActiveSockets();
    const stops = [...base.slots.values()].map((slot) => slot.sandbox?.shutdown()).filter(Boolean);
    if (base.pool) stops.push(base.pool.shutdown());
    for (const r of await Promise.allSettled(stops)) {
      if (r.status === "rejected") console.warn("Sandbox termination failed:", r.reason);
    }
    nodeServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// Only boot when executed as an entry (not when imported by tests).
if (process.env.VITEST === undefined) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
