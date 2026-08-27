// Copyright 2026 the AAI authors. MIT license.
/**
 * Every process-lifetime background pass the AGENT surface owns, started once.
 *
 * Four of them, and they were inline in `orchestrator.ts` until the fourth
 * arrived and pushed that file past its length cap — which is the cheap reason.
 * The real one is that they are one KIND of thing and nothing else in that file
 * is: a route registration answers a request and returns, while each of these
 * lives for the process, runs on a timer, and takes its dependencies from the
 * same three places (`opts`, the assembled broker, the platform's admin
 * connection). Reading them together is how you see what this replica is doing
 * when nobody is calling it.
 *
 * They stay wired to the agent surface rather than to an entry point for the
 * reason `watchAgentInvalidation` does: an entry that has to REMEMBER to start a
 * sweep is an entry that will not, and a durable run then advances on some
 * deployments and not others. A composition with no platform database starts
 * nothing — each of these is inert without one, and says so itself rather than
 * being guarded here.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { AppDatabases } from "./app-database.ts";
import type { BundleStore } from "./bundle-store.ts";
import { startOrphanPreviewSweep } from "./orphan-previews.ts";
import { startPlatformDbPressureSweep } from "./platform-db-pressure.ts";
import type { AdminDb, SlugMutationLock } from "./platform-lock.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";
import type { SecretStore } from "./secret-store.ts";
import { createQueueDeliverer } from "./workflow-queue-deliver.ts";
import { startWorkflowQueueSweep } from "./workflow-queue-sweep.ts";
import { startWorkflowWakeSweep } from "./workflow-wake.ts";

export type AgentSweepOptions = {
  store: BundleStore;
  /** The broker's dependency set, already assembled by the caller. */
  broker: ResolveSandboxOpts;
  secrets?: SecretStore | undefined;
  slugLock?: SlugMutationLock | undefined;
  adminDb?: AdminDb | undefined;
  appDb?: AppDatabases | undefined;
  extraAppDbClusters?: number | undefined;
  isDraining?: (() => boolean) | undefined;
};

/**
 * Start all four. Fire-and-forget: each returns its own stop, and none is kept,
 * because these live exactly as long as the process does.
 *
 * @internal
 */
export function startAgentSweeps(opts: AgentSweepOptions): void {
  // Durable runs whose sandbox is long gone (workflow-wake.ts).
  startWorkflowWakeSweep({
    store: opts.store,
    broker: opts.broker,
    // BOTH, and the sweep is inert without either — omitting one type-checks;
    // see the `startWorkflowWakeSweep` branch for what that cost.
    ...omitUndefined({ adminDb: opts.adminDb }),
    ...omitUndefined({ appDb: opts.appDb }),
    ...omitUndefined({ isDraining: opts.isDraining }),
    ...omitUndefined({ extraAppDbClusters: opts.extraAppDbClusters }),
  });

  // Platform-owned queue delivery (workflow-queue-sweep.ts). Started even though
  // nothing enqueues yet, and that is deliberate: the harness is baked into the
  // guest snapshot image, so the guest's delivery door ships an image ahead of
  // the platform that uses it, and leaving the sweep off would keep this whole
  // path unexercised until the change that most needs it to already work. A tick
  // over an empty queue is one indexed lookup against a partial index that
  // covers exactly its predicate.
  startWorkflowQueueSweep({
    ...omitUndefined({ adminDb: opts.adminDb }),
    deliver: createQueueDeliverer({ store: opts.store, broker: opts.broker }),
    ...omitUndefined({ isDraining: opts.isDraining }),
  });

  // Where the instance's connection slots have actually gone
  // (platform-db-pressure.ts) — its own sweep rather than a rider on the one
  // above; that module's doc says why.
  startPlatformDbPressureSweep({ ...omitUndefined({ adminDb: opts.adminDb }) });

  // Studio previews nothing references any more (orphan-previews.ts). The same
  // shape as the wake sweep — a leader-elected in-process pass — and it reaps
  // through `deleteAgentResources`, the one delete path this surface owns. It
  // ran in pg_cron until per-app databases moved to the Management API; that
  // module's doc has the argument.
  startOrphanPreviewSweep({
    store: opts.store,
    ...omitUndefined({ secrets: opts.secrets }),
    ...omitUndefined({ slugLock: opts.slugLock }),
    ...omitUndefined({ appDb: opts.appDb }),
    ...omitUndefined({ adminDb: opts.adminDb }),
  });
}
