// Copyright 2026 the AAI authors. MIT license.
/**
 * Every process-lifetime background pass the AGENT surface owns, started once.
 *
 * ONE, as of this change. There were four: they were inline in `orchestrator.ts`
 * until the last arrival pushed that file past its length cap, which was the cheap
 * reason for the split. Three are gone — the wake sweep and the orphan-preview
 * reaper for the reasons stated in the body, and the pressure sweep with the
 * per-app databases it measured — and the seam is worth keeping anyway. The real
 * reason is that this is one KIND of thing and nothing else in that file is: a
 * route registration answers a request and returns, while this lives for the
 * process, runs on a timer, and takes its dependencies from the same places
 * (`opts`, the assembled broker, the platform's admin connection). It is also the
 * one place a reader can see what this replica does when nobody is calling it,
 * which a five-line call inlined back into a 400-line composition root is not.
 *
 * They stay wired to the agent surface rather than to an entry point for the
 * reason `watchAgentInvalidation` does: an entry that has to REMEMBER to start a
 * sweep is an entry that will not, and a durable run then advances on some
 * deployments and not others. A composition with no platform database starts
 * nothing — each of these is inert without one, and says so itself rather than
 * being guarded here.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { BundleStore } from "./bundle-store.ts";
import type { AdminDb } from "./platform-lock.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";
import { createQueueDeliverer } from "./workflow-queue-deliver.ts";
import { startWorkflowQueueSweep } from "./workflow-queue-scheduler.ts";

export type AgentSweepOptions = {
  store: BundleStore;
  /** The broker's dependency set, already assembled by the caller. */
  broker: ResolveSandboxOpts;
  adminDb?: AdminDb | undefined;
  isDraining?: (() => boolean) | undefined;
};

/**
 * Start them. Fire-and-forget: each returns its own stop and none is kept, because
 * these live exactly as long as the process does.
 *
 * @internal
 */
export function startAgentSweeps(opts: AgentSweepOptions): void {
  // The WAKE sweep used to run here, reading a per-app `wake_at` hint to learn when
  // to boot a guest for a run whose sandbox was gone. It is retired: the delivery
  // sweep below IS the wake — it claims due messages and brokers a sandbox to
  // deliver them — and it does it from a table with a `slug` and an `available_at`,
  // which is the query the DevKit's own schema could not answer and the whole reason
  // the hint existed. What went with it: a per-app connection per tick, a
  // leader election, a per-slug backoff, and a table in every tenant's schema.

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

  // Studio previews nothing references any more are reaped by pg_cron
  // (`aai-sweep-orphan-previews`), not from here. With no per-app database to
  // drop, a reap is a Vault row and an agents row — see that job's doc in
  // `pg-cron.ts` for why the move back is safe and what guards it.
}
