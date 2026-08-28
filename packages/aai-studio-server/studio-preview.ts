// Copyright 2026 the AAI authors. MIT license.
/**
 * Auto preview deploys — the studio's "your edits go live somewhere
 * immediately" half of the preview/production split.
 *
 * Every edit (an agent turn's `studio/sync-workspace`, an editor file
 * PUT/DELETE) schedules a deploy of the workspace to the project's PREVIEW
 * slug (`<project>-preview`), through the exact same in-sandbox `aai deploy`
 * path Publish uses. Publish stays the only way to touch the production
 * slug; the Preview pane shows the preview slug, so edits appear there
 * without the user shipping anything.
 *
 * Scheduling is DURABLE: an edit enqueues a job in the platform's queue
 * (`studio-preview-queue.ts` — pgmq in production) and the local drain runs
 * it. A replica restart or a sandbox death mid-deploy therefore no longer
 * drops the work; the job becomes visible again and any replica picks it up.
 *
 * Coalescing falls out of that rather than being managed: the deploy re-reads
 * the workspace and no-ops when `previewHash` already matches the current
 * files, and the drain holds a per-project lock, so a burst of tool-call
 * edits costs one deploy and its duplicates cost a read each. This replaced
 * an in-process map with a dirty bit, whose whole purpose was to approximate
 * that with no durability.
 *
 * Outcomes are stamped on the workspace like Publish's metadata: success
 * writes `previewSlug`/`previewHash` (what tells the client a new preview is
 * up), failure writes `previewError` for the Preview pane's banner — an
 * auto-deploy has no chat turn to carry its CLI output.
 */

import { errorMessage } from "@alexkroman1/aai";
import { createCoalescingRunner } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { createKeyedLock, TtlCache, withLock } from "aai-server/platform-barrel";
import type { WorkspaceStore } from "aai-server/workspace-store";
import {
  type ClaimedPreviewJob,
  PREVIEW_JOB_MAX_ATTEMPTS,
  PREVIEW_JOB_VISIBILITY_MS,
  type PreviewJob,
  type PreviewQueue,
} from "./studio-preview-queue.ts";
import { previewSlugFor } from "./studio-project-slugs.ts";
import type { StudioSessionBroker } from "./studio-session-broker.ts";
import { getWorkspace, projectKey, stampWorkspaceMeta } from "./studio-workspace.ts";

/** Cap on the stored preview failure output (it renders in a banner). */
const MAX_PREVIEW_ERROR = 16_000;

/**
 * Force this project's preview to redeploy: clear the `previewHash` stamp,
 * then schedule a deploy. Both halves, always — which is the entire reason
 * this is a function.
 *
 * The clear is what makes the scheduled deploy RUN. `attempt` no-ops when the
 * stamped hash matches the current files, and that is exactly the state every
 * caller here is in: nothing about the FILES changed, the environment around
 * them did — a database switched on, a secret saved, the deployed agent gone
 * missing. Scheduling without clearing enqueues a job that reads the workspace
 * and returns.
 *
 * It was open-coded three times, with two different omissions between them,
 * and one of those omissions was a bug: `wakeProjectPreview`'s
 * settled-`previewError` retry scheduled WITHOUT clearing, so the one state it
 * exists to rescue — a failed deploy whose files were then reverted to the
 * last good ones — was the one it could not rescue. (The other divergence is
 * harmless and stays at the call sites: the database and secret switches skip
 * the whole thing for a project with no `previewSlug`, since there is no
 * preview agent to update yet.)
 */
export async function forcePreviewRedeploy(
  workspaces: WorkspaceStore,
  scope: string,
  project: string,
  schedule: () => void,
): Promise<void> {
  await stampWorkspaceMeta(workspaces, scope, project, { previewHash: undefined });
  schedule();
}

/** What a preview deploy needs beyond the workspace: origin + caller key. */
export type PreviewTarget = {
  /** Public platform origin the guest's CLI deploys to. */
  serverUrl: string;
  apiKey: string;
  /**
   * The studio user the key belongs to, when the caller is a browser session.
   * This is what makes a job durable: the queue row carries the user id, and
   * the drain resolves the key from Vault — a credential never becomes a
   * Postgres row. Absent for raw-key callers (the CLI, evals), whose jobs
   * therefore only survive as long as this replica does (see `schedule`).
   */
  userId?: string;
};

/**
 * A {@link PreviewTarget} minus the credential — what a caller hands the
 * session broker so the sandbox it installs can schedule its own previews
 * later (the guest's end-of-turn sync); the broker pairs it with the session's
 * `apiKey`.
 *
 * DERIVED from `PreviewTarget` rather than spelled out, so a field added
 * there is a compile error at every point that builds one of these instead of
 * a field the queue row silently loses. `userId` was exactly that loss: the
 * broker took a bare `serverUrl` string, so agent-turn previews could not name
 * their user and were archived on any cross-replica redelivery.
 */
export type PreviewOrigin = Omit<PreviewTarget, "apiKey">;

export type PreviewDeployer = {
  /**
   * Enqueue a deploy of the project's current workspace to its preview slug,
   * and kick the drain. Fire-and-forget: never throws, never blocks the
   * caller's response.
   */
  schedule(scope: string, project: string, target: PreviewTarget): void;
  /** Stop the periodic drain. */
  dispose(): void;
};

export type PreviewDeployerOptions = {
  workspaces: WorkspaceStore;
  /** The broker's `deployWorkspace` — the in-sandbox `aai deploy` run. */
  deployWorkspace: StudioSessionBroker["deployWorkspace"];
  /** Durable job queue: pgmq in production, in-memory in dev/tests. */
  queue: PreviewQueue;
  /**
   * A studio user's stored AssemblyAI key, for jobs this replica did not
   * enqueue. Without it (dev/tests) only same-replica jobs can deploy.
   */
  resolveApiKey?: (userId: string) => Promise<string | null>;
  /**
   * How often to look for jobs nobody is working on — a dead replica's
   * redelivered work. Also the ceiling on how long a dropped deploy stays
   * dropped. 0 disables the timer (tests drive `drainOnce` directly).
   */
  pollMs?: number;
};

/** Default drain cadence. Well under the pane's tolerance for staleness. */
export const PREVIEW_DRAIN_POLL_MS = 15_000;
const PREVIEW_DRAIN_BATCH = 5;

/**
 * How long a raw-key caller's credential stays available to the drain: long
 * enough to cover every redelivery of a job this replica enqueued, and no
 * longer. A TTL rather than deletion-on-settle because several jobs for one
 * project are routine (a turn-complete sync plus two editor PUTs) and they
 * share the one entry — dropping it when the first settled left the rest with
 * no credential and archived them.
 */
const LOCAL_KEY_TTL_MS = PREVIEW_JOB_VISIBILITY_MS * (PREVIEW_JOB_MAX_ATTEMPTS + 1);

/**
 * How long a claimed job may wait on its project's lock before it is handed
 * back to the queue.
 *
 * A claimed job is INVISIBLE to the rest of the fleet for
 * {@link PREVIEW_JOB_VISIBILITY_MS}, so waiting on an in-process lock spends
 * the queue's own durability: a project whose lock is wedged (a deploy stuck
 * on an unreachable sandbox — the request paths carry deadlines, this one is
 * bookkeeping under a lock and does not) holds every later job for that
 * project off the fleet for the full five minutes, and they are the jobs most
 * likely to be the ones the user is waiting on. Giving up leaves the job
 * UNACKED, which is the queue's existing redelivery path — the same outcome
 * as a deploy that threw.
 *
 * Derived from the visibility timeout rather than written down separately:
 * the only requirement is that it lapse first, and half leaves the redelivery
 * a wide margin. It is far above a real wait — a deploy is seconds to tens of
 * seconds, and the jobs queued behind one for the same project find
 * `previewHash` current and no-op.
 */
const PREVIEW_LOCK_WAIT_MS = Math.floor(PREVIEW_JOB_VISIBILITY_MS / 2);

/** Log-and-continue wrapper: queue trouble must never fail a caller's request. */
function bestEffort(what: string): (err: unknown) => undefined {
  return (err: unknown) => {
    console.warn(`Preview queue ${what} failed: ${errorMessage(err)}`);
  };
}

export function createPreviewDeployer(
  options: PreviewDeployerOptions,
): PreviewDeployer & { drainOnce(): Promise<void> } {
  const projectLock = createKeyedLock();
  /**
   * Keys for jobs enqueued by THIS replica, so a raw-key caller's preview
   * still deploys without its credential ever becoming a queue row. Bounded
   * and expiring (see {@link LOCAL_KEY_TTL_MS}); a job redelivered to another
   * replica finds no entry there and needs `resolveApiKey`.
   */
  const localKeys = new TtlCache<string>(LOCAL_KEY_TTL_MS, 1000);

  /** One deploy attempt against the workspace's CURRENT files. */
  async function attempt(scope: string, project: string, target: PreviewTarget): Promise<void> {
    const workspace = await getWorkspace(options.workspaces, scope, project);
    if (!workspace) return;
    const hash = workspace.hash;
    if (workspace.previewHash === hash) {
      // Nothing to deploy — but a stamped failure over ALREADY-DEPLOYED files
      // is a banner nothing else can ever clear, so clear it here.
      //
      // The state is ordinary: a bad edit fails its deploy and stamps
      // `previewError` while `previewHash` still names the last good deploy;
      // the user reverts, the files hash returns to that value, and this
      // early return used to fire BEFORE anything was stamped. The pane then
      // showed a build error for code that was no longer in the workspace,
      // for as long as the project lived, with every later edit that hashed
      // back to this one re-confirming it. Only a SUCCESSFUL deploy deleted
      // the stamp, and this is the one case where success needs no deploy.
      if (workspace.previewError !== undefined) {
        await stampWorkspaceMeta(options.workspaces, scope, project, { previewError: undefined });
      }
      return;
    }
    const slug = workspace.previewSlug ?? previewSlugFor(project);
    const outcome = await options.deployWorkspace(scope, project, workspace.files, {
      serverUrl: target.serverUrl,
      apiKey: target.apiKey,
      slug,
      // The reserved-suffix opt-in belongs to THIS caller alone: the slug
      // above is deliberately `<project>-preview`, and the deploy boundary
      // rejects that suffix for everyone else — including Publish, which
      // shares the deploy path below.
      allowPreviewSlug: true,
    });
    // Stamp only the preview metadata (mirrors the Publish stamp in
    // studio-deploy.ts): the deploy takes seconds, and writing the
    // pre-deploy files back would revert anything edited meanwhile. `hash`
    // is of the snapshot that was deployed, so mid-deploy edits still read
    // as preview-stale — and the job the edit enqueued deploys them next.
    await stampWorkspaceMeta(
      options.workspaces,
      scope,
      project,
      outcome.ok
        ? { previewSlug: outcome.slug ?? slug, previewHash: hash, previewError: undefined }
        : { previewError: outcome.output.slice(0, MAX_PREVIEW_ERROR) },
    );
    if (!outcome.ok) {
      console.warn("Studio preview deploy failed", { project, output: outcome.output });
    }
  }

  /**
   * The key one claimed job runs on. Null means the job cannot be run here.
   *
   * A job naming a studio user resolves its key from Vault — the durable
   * path, and the only one a job redelivered to another replica can take, so
   * it is tried first: it is also the fresher answer if the user rotated
   * their key since the edit. The in-process map covers raw-key callers (the
   * CLI, evals), whose credential deliberately never becomes a queue row.
   */
  async function keyFor(job: PreviewJob): Promise<string | null> {
    if (job.userId && options.resolveApiKey) {
      const resolved = await options.resolveApiKey(job.userId).catch(() => null);
      if (resolved) return resolved;
    }
    return localKeys.get(projectKey(job.scope, job.project)) ?? null;
  }

  async function runJob(claimed: ClaimedPreviewJob): Promise<void> {
    const { scope, project, serverUrl } = claimed.job;
    const apiKey = await keyFor(claimed.job);
    if (!apiKey) {
      // Nothing here can deploy it. Archiving beats redelivering forever:
      // the only jobs that reach this are raw-key callers' whose enqueuing
      // replica is gone, and no replica will ever hold their credential.
      console.warn("Archiving preview job with no resolvable credential", { project });
      await options.queue.archive(claimed.id).catch(bestEffort("archive"));
      return;
    }
    // Per project, so two jobs for one project cannot deploy concurrently —
    // the second finds `previewHash` current and no-ops. Bounded: a claimed
    // job waiting here is invisible to the fleet, so a wedged lock must hand
    // it back rather than sit on it (see PREVIEW_LOCK_WAIT_MS). A lapsed
    // acquire rejects, which leaves the job unacked for redelivery — the same
    // path a deploy that threw takes.
    await withLock(
      projectLock,
      projectKey(scope, project),
      () => attempt(scope, project, { serverUrl, apiKey }),
      { timeoutMs: PREVIEW_LOCK_WAIT_MS },
    );
    // Settled (deployed, or stamped with a build failure): the job is done
    // either way. A build error is deterministic, so retrying it would just
    // rewrite the same banner.
    await options.queue.ack(claimed.id).catch(bestEffort("ack"));
  }

  /**
   * One drain pass. A job whose run THROWS (transport failure, dead sandbox
   * mid-deploy) is deliberately left unacked: it becomes visible again after
   * the visibility timeout, which is the durability this queue exists for.
   * Past {@link PREVIEW_JOB_MAX_ATTEMPTS} redeliveries it is archived — at
   * that point it is a crash loop, not a slow deploy.
   */
  async function drainOnce(): Promise<void> {
    const claimed = await options.queue
      .claim(PREVIEW_DRAIN_BATCH)
      .catch(() => [] as ClaimedPreviewJob[]);
    await Promise.all(
      claimed.map(async (job) => {
        if (job.attempts > PREVIEW_JOB_MAX_ATTEMPTS) {
          console.warn("Archiving preview job after repeated failures", {
            project: job.job.project,
            attempts: job.attempts,
          });
          await options.queue.archive(job.id).catch(bestEffort("archive"));
          return;
        }
        try {
          await runJob(job);
        } catch (err) {
          // Left for redelivery on purpose — see the doc above.
          console.warn("Studio preview deploy errored", {
            project: job.job.project,
            attempts: job.attempts,
            error: errorMessage(err),
          });
        }
      }),
    );
  }

  /**
   * Both drain triggers — the timer and every `schedule` — go through one
   * coalescing runner.
   *
   * Unserialized, an edit burst (several turn-complete syncs plus editor PUTs)
   * fired N overlapping drains, each paying its own `pgmq.read`, and jobs
   * claimed by the losers then sat invisible on the per-project lock burning
   * their visibility window. The in-process pump this queue replaced DID
   * coalesce; the primitive is how that property comes back without the
   * hand-rolled flags (see `createCoalescingRunner`). A drain reads latest
   * state when it runs, which is exactly what makes collapsing N triggers into
   * one run plus one trailing run safe.
   */
  const drain = createCoalescingRunner(drainOnce);
  const triggerDrain = (): void => void drain.trigger().catch(bestEffort("drain"));

  const pollMs = options.pollMs ?? PREVIEW_DRAIN_POLL_MS;
  // Unref'd: a pending preview drain must never hold the process open.
  const timer = pollMs > 0 ? setInterval(triggerDrain, pollMs) : undefined;
  timer?.unref?.();

  return {
    schedule(scope, project, target) {
      const key = projectKey(scope, project);
      // Overwrite rather than keep the first: a rotated key belongs to the
      // same account, and the latest caller's is the one known to work.
      localKeys.set(key, target.apiKey);
      void options.queue
        .enqueue({
          scope,
          project,
          serverUrl: target.serverUrl,
          ...omitUndefined({ userId: target.userId }),
        })
        .then(triggerDrain)
        .catch(bestEffort("enqueue"));
    },
    drainOnce,
    dispose() {
      if (timer) clearInterval(timer);
    },
  };
}
