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

import { DEFAULT_PORT, DRAIN_GUEST_POLL_MS } from "aai-server/constants";
import { createOrchestrator } from "aai-server/orchestrator";
import { resolvePort } from "aai-server/platform-barrel";
import { drainActiveSessions, startService } from "aai-server/serve-lifecycle";
import {
  assertSandboxBackendOrWarn,
  buildServiceConfig,
  installProcessSafetyNets,
  type ServiceConfig,
} from "aai-server/service-config";
import { isStudioPath } from "aai-server/studio-proxy";
import { liveGuestSessions, teardownSandboxes } from "aai-server/teardown-sandboxes";
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
    events: base.events,
    ...(base.secrets && { secrets: base.secrets }),
    ...(base.auth && { auth: base.auth }),
    ...(base.appDb && { appDb: base.appDb }),
    ...(base.slugLock && { slugLock: base.slugLock }),
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
  const port = resolvePort(env.PORT, DEFAULT_PORT);
  const mode = resolveServiceMode(env);

  let draining = false;
  const base = buildServiceConfig(env);
  assertSandboxBackendOrWarn(env);

  const { app: studioApp, dispose: disposeStudio } = createStudioApp(
    studioAppOpts(base, () => draining),
  );
  // The broker's per-project coding-agent sandboxes are this process's to
  // release: without the dispose they outlive it and burn their orphan
  // timeout (billed, on Modal) on every scale-in. Shared by both modes so
  // the two shutdown paths cannot drift.
  const teardown = async (): Promise<void> => {
    await teardownSandboxes({
      slots: base.slots,
      pool: base.pool,
      broker: { dispose: disposeStudio },
    });
    await base.events.close();
  };

  if (mode === "studio") {
    await startService({
      label: "AAI studio service",
      fetch: studioApp.fetch,
      port,
      // No session drain here, unlike the agent and combined entries: this
      // service serves no voice sessions, and chat turns are bounded HTTP/SSE
      // requests, so there is nothing long-lived to wait out.
      onShutdown: async () => {
        draining = true;
        console.info("Studio service shutting down...");
        await teardown();
      },
    });
    return;
  }

  // Combined: both apps in one process, dispatched by path. Each app carries
  // its own bindings via its wrapped fetch, so no route mounting (which
  // would bypass the studio app's bindings injection) is involved.
  // `base.events` rides into the orchestrator, which wires the agents-row
  // change stream to sandbox invalidation (the studio-only mode has no
  // orchestrator and an always-empty slot cache — nothing to invalidate).
  const orchestrator = createOrchestrator({ ...base, isDraining: () => draining });
  const combinedFetch = (req: Request): Response | Promise<Response> =>
    isStudioPath(new URL(req.url).pathname) ? studioApp.fetch(req) : orchestrator.app.fetch(req);

  await startService({
    label: "AAI server (combined)",
    fetch: combinedFetch,
    port,
    injectWebSocket: (server) => orchestrator.injectWebSocket(server),
    // Same drain posture as the agent service's entry — and now literally the
    // same code path, so the two can no longer drift.
    onShutdown: async () => {
      draining = true;
      // The count is the guests' sessions — see the agent entry: sessions
      // live in the sandboxes, and this process terminates none of its own.
      await drainActiveSessions({
        activeCount: () => liveGuestSessions(base.slots),
        pollMs: DRAIN_GUEST_POLL_MS,
        env,
      });
      console.info("Shutting down...");
      await teardown();
    },
  });
}

// Only boot when executed as an entry (not when imported by tests).
if (process.env.VITEST === undefined) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
