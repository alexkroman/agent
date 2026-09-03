// Copyright 2026 the AAI authors. MIT license.
/**
 * Node.js entry point for the whole platform — the composition root for BOTH
 * apps, and the only entry any deployment runs.
 *
 * One process serves both surfaces behind one fetch dispatcher: studio paths
 * (`/`, `/favicon.ico`, `/studio*`, `/studio-assets/*` — `isStudioPath`) go to
 * the studio app, everything else (including `/health` and the WebSocket
 * upgrades) to the agent orchestrator. Both apps share one ServiceConfig, so
 * they share the slot cache and stores too.
 *
 * `AAI_SERVICE` used to select between this and two split-deployment modes (a
 * standalone `studio` service here, an agent-only service with a reverse proxy
 * in aai-server). Production never ran the split, so both are gone; the env var
 * is still SET to `combined` by modal_deploy.py and read for nothing, which is
 * deliberate — it documents the shape at the deploy boundary and is the hook a
 * revived split would branch on. See "One app, both surfaces" in
 * packages/aai-server/src/modal_deploy.py.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { DEFAULT_PORT } from "aai-server/constants";
import { createOrchestrator } from "aai-server/orchestrator";
import { resolvePort } from "aai-server/platform-barrel";
import { createPgAgentRateLimiters } from "aai-server/rate-limit";
import { startService } from "aai-server/serve-lifecycle";
import {
  assertSandboxBackendOrWarn,
  assertStorageBucket,
  buildServiceConfig,
  installProcessSafetyNets,
  type ServiceConfig,
} from "aai-server/service-config";
import { isStudioPath } from "aai-server/studio-paths";
import { teardownSandboxes } from "aai-server/teardown-sandboxes";
import { createStudioApp, type StudioAppOpts } from "./studio-app.ts";
import { createMemoryPreviewQueue, createPgPreviewQueue } from "./studio-preview-queue.ts";
import { createPgStudioRateLimiters, type StudioRateLimiters } from "./studio-rate-limit.ts";
import { createPgStudioSessionRegistry } from "./studio-session-registry.ts";

/** Postgres rate limiters when the platform database is configured; else memory defaults apply. */
function buildRateLimiters(base: ServiceConfig): StudioRateLimiters | undefined {
  // ALL of them, from the factory beside the windows — never a hand-listed
  // subset here. A window this root forgets falls through to the in-memory
  // arm and silently enforces `MAX_CONTAINERS` times what it says.
  return base.sql ? createPgStudioRateLimiters(base.sql) : undefined;
}

/**
 * The agent surface's fleet-wide per-IP limiters, when a platform database is
 * configured. All three at once, from one factory in the package that owns the
 * windows — see `createPgAgentRateLimiters` for why this is not three builders.
 */
function buildAgentRateLimiters(
  base: ServiceConfig,
): ReturnType<typeof createPgAgentRateLimiters> | undefined {
  if (!base.sql) return;
  return createPgAgentRateLimiters(base.sql);
}

function studioAppOpts(base: ServiceConfig, isDraining: () => boolean): StudioAppOpts {
  const rateLimiters = buildRateLimiters(base);
  // Cross-replica studio session registry — only with a platform database.
  // Without one there is a single process, so there are no peers to find.
  const sessionRegistry = base.sql ? createPgStudioSessionRegistry(base.sql) : undefined;
  // Durable preview deploys — pgmq with a platform database, an in-memory
  // queue without one. THIS is the decision, and it is the only one: the broker
  // used to make a second one (`options.previewQueue ??
  // createMemoryPreviewQueue()`) that could only ever disagree with this, and
  // did so silently. The memory tier announces itself the way every other
  // memory selection in this codebase does, because losing pending previews on
  // restart is a behaviour difference a developer should see in the boot log.
  const previewQueue = base.sql ? createPgPreviewQueue(base.sql) : createMemoryPreviewQueue();
  if (!base.sql) {
    console.info("Local dev mode: in-memory preview queue; pending previews are lost on restart");
  }
  return {
    store: base.store,
    workspaces: base.workspaces,
    chats: base.chats,
    events: base.events,
    ...omitUndefined({
      secrets: base.secrets,
      auth: base.auth,
      keyVerifier: base.keyVerifier,
      slugLock: base.slugLock,
      studioRateLimiters: rateLimiters,
      studioSessionRegistry: sessionRegistry,
    }),
    previewQueue,
    replicaId: base.replicaId,
    isDraining,
  };
}

async function main(): Promise<void> {
  installProcessSafetyNets();

  const env = process.env;
  const port = resolvePort(env.PORT, DEFAULT_PORT);

  let draining = false;
  const base = await buildServiceConfig(env);
  assertSandboxBackendOrWarn(env);
  // Awaited, so a bucket that is missing or PUBLIC refuses the boot — the one
  // piece of this platform's Supabase state that lives in the dashboard
  // rather than in `supabase/migrations`, and so the one nothing else checks.
  // A merely unreachable Storage warns and lets the service up; see
  // assertBucketPrivate for why that asymmetry is deliberate.
  await assertStorageBucket(env);

  const { app: studioApp, dispose: disposeStudio } = createStudioApp(
    studioAppOpts(base, () => draining),
  );
  // The broker's per-project coding-agent sandboxes are this process's to
  // release: without the dispose they outlive it and burn their orphan
  // timeout (billed, on Modal) on every scale-in.
  const teardown = async (): Promise<void> => {
    await teardownSandboxes({ slots: base.slots, broker: { dispose: disposeStudio } });
    await base.events.close();
  };

  // Both apps in one process, dispatched by path. Each app carries
  // its own bindings via its wrapped fetch, so no route mounting (which
  // would bypass the studio app's bindings injection) is involved.
  // `base.events` rides into the orchestrator, which wires the agents-row
  // change stream to sandbox invalidation.
  const orchestrator = createOrchestrator({
    ...base,
    ...buildAgentRateLimiters(base),
    isDraining: () => draining,
  });
  const combinedFetch = (req: Request): Response | Promise<Response> =>
    isStudioPath(new URL(req.url).pathname) ? studioApp.fetch(req) : orchestrator.app.fetch(req);

  await startService({
    label: "AAI server (combined)",
    fetch: combinedFetch,
    port,
    injectWebSocket: (server) => orchestrator.injectWebSocket(server),
    // Agent guests are RETIRED (they finish their calls and exit on their own
    // clock — see teardown-sandboxes.ts); studio guests go down with the
    // broker, being useless without this process's control channel.
    onShutdown: async () => {
      draining = true;
      console.info("Shutting down (retiring guests)...");
      await teardown();
    },
  });
}

/**
 * Compile-cache warm-up: evaluate the module graph and exit 0, opening
 * nothing.
 *
 * The deploy image runs the built entry once in this mode under
 * `NODE_COMPILE_CACHE` and snapshots the result into the image
 * (`scripts/modal_image.py`), so every container boot reads a populated V8
 * cache instead of recompiling the bundle — the same trick the guest harness
 * uses (`AAI_GUEST_WARMUP`, ~570ms → ~345ms there). Static imports are
 * evaluated BEFORE this line, so the whole graph — the bundle plus every npm
 * dependency it imports statically — is compiled by the time we exit.
 *
 * It doubles as a build-time smoke test of the bundle, which is why a failure
 * here is deliberately fatal to the image build: a graph that cannot be
 * evaluated cannot serve a request either.
 */
if (process.env.AAI_SERVER_WARMUP === "1") {
  process.exit(0);
}

// Only boot when executed as an entry (not when imported by tests).
if (process.env.VITEST === undefined) {
  main().catch((err: unknown) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
