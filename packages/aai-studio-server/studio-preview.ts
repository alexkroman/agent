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
import { MAX_SLUG_LENGTH, PREVIEW_SLUG_SUFFIX } from "@alexkroman1/aai/utils";
import { createKeyedLock, TtlCache, withLock } from "aai-server/platform-barrel";
import type { WorkspaceStore } from "aai-server/workspace-store";
import {
  type ClaimedPreviewJob,
  PREVIEW_JOB_MAX_ATTEMPTS,
  PREVIEW_JOB_VISIBILITY_MS,
  type PreviewJob,
  type PreviewQueue,
} from "./studio-preview-queue.ts";
import type { StudioSessionBroker } from "./studio-session-broker.ts";
import { currentFilesHash, getWorkspace, mutateWorkspace, projectKey } from "./studio-workspace.ts";

/** Cap on the stored preview failure output (it renders in a banner). */
const MAX_PREVIEW_ERROR = 16_000;

/**
 * How long the warm-up request may hold its socket. The broker call boots
 * the sandbox as a side effect of answering, so even an aborted request has
 * done its job — the timeout only stops us pinning a connection to a slow
 * cold boot.
 */
const PREVIEW_WARM_TIMEOUT_MS = 30_000;

/**
 * Fire-and-forget sandbox warm-up for the agent the Preview pane embeds.
 *
 * Landing on a project after an absence usually finds the preview agent's
 * sandbox idle-evicted; its next boot would otherwise start only once the
 * pane's iframe has loaded and its client fetches `/client-config`. Hitting
 * the platform's public client-config broker — the same pre-connection
 * lookup the agent page makes — starts that boot the moment the project is
 * opened instead. Primarily an accelerator: failures resolve to `null`
 * rather than throwing, because the iframe's own fetch remains the
 * functional path.
 *
 * The one answer the caller acts on is the HTTP status, returned so
 * {@link wakeProjectPreview} can tell an agent the platform no longer knows
 * (404 — the deploy behind the workspace's preview stamp is GONE) from one
 * that is merely booting (503) or answering normally.
 */
export function warmPreviewSandbox(
  serverUrl: string,
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  let url: URL;
  try {
    url = new URL(`/${encodeURIComponent(slug)}/client-config`, serverUrl);
  } catch {
    return Promise.resolve(null);
  }
  return fetchImpl(url, { signal: AbortSignal.timeout(PREVIEW_WARM_TIMEOUT_MS) }).then(
    (res) => res.status,
    () => null,
  );
}

/**
 * Landing on a project wakes its preview. Hung off the once-per-open
 * session broker call (`POST /projects/:project/session`) — the "user is
 * looking at this project again" signal. Fire-and-forget: the caller's
 * response never waits on it.
 *
 * It does ONE thing now: warm the sandbox of the agent the pane embeds (the
 * preview, falling back to the production agent for projects published
 * before previews existed) via {@link warmPreviewSandbox}, so a preview
 * idle-evicted since the last visit is booting before the pane's iframe
 * asks for it.
 *
 * It used to ALSO redeploy a stale preview, because scheduling was
 * fire-and-forget in-process state and a replica restart could drop a
 * deploy — leaving the pane on "Updating preview…" with nothing on the way
 * until the next edit. The queue (studio-preview-queue.ts) makes that
 * delivery durable, so a STALE preview means a job is still queued and the
 * drain will run it. Re-scheduling that here would be a second mechanism
 * answering the same question, and the weaker one: it only fires when a
 * human opens the project.
 *
 * It then does two things the queue does NOT cover, both of them cases where
 * no job exists and the workspace stamp cannot correct itself:
 *
 * - **A 404 from the broker** means the platform no longer knows the agent at
 *   all — the deploy behind the workspace's preview stamp is GONE
 *   (expired/swept/deleted out from under it), so "preview is current" is a
 *   lie, and no queued job exists because nothing was edited. That clears
 *   `previewHash` (else the deploy no-ops on the matching hash) and enqueues
 *   a deploy. Only 404 triggers it: a 503 means a sandbox mid-boot (the
 *   broker keeps booting it and the pane's own fetch retries), and
 *   redeploying on that would churn a healthy slow boot.
 * - **A stamped `previewError`** is a SETTLED failure: the job ran, failed,
 *   and left the queue. So there is no queued job to defer to here either,
 *   and nothing short of another edit would ever retry it. This deliberately
 *   does NOT try to tell a deterministic failure (broken code, which will
 *   re-fail into the same banner) from a transient one (a platform 500, a
 *   Storage blip, a deploy racing a redeploy) — the only signal available is
 *   the CLI's output prose, and sniffing it is exactly the check that breaks
 *   when a message is reworded. The trade is asymmetric: being wrong costs
 *   one extra deploy per project-open, re-stamping the banner that is already
 *   there, while not retrying leaves a transient failure stuck permanently.
 *   The stamp itself is left in place — a successful deploy deletes it
 *   (see `attempt`), so the pane keeps showing the last real error until
 *   there is something better to say, rather than flickering to "starting".
 */
export function wakeProjectPreview(options: {
  workspaces: WorkspaceStore;
  scope: string;
  project: string;
  target: PreviewTarget;
  /** The broker's `schedulePreview` — called when the stamped agent is gone. */
  schedule: PreviewDeployer["schedule"];
  fetchImpl?: typeof fetch;
}): void {
  const { workspaces, scope, project, target } = options;
  void getWorkspace(workspaces, scope, project)
    .then(async (workspace) => {
      if (!workspace) return;
      // Nothing deployable in a fresh workspace — the first agent turn owns
      // the first preview.
      if (Object.keys(workspace.files).length === 0) return;
      // A settled failure has no queued job behind it, so this is the only
      // thing that can retry it (see the doc comment).
      const retrySettledFailure = Boolean(workspace.previewError);
      const slug = workspace.previewSlug ?? workspace.deployedSlug;
      // Warm whatever the pane embeds even when a retry is already decided:
      // on a failure that followed a working deploy, `previewSlug` still
      // points at that agent and the pane loads it while the retry runs.
      // Doubles as an existence check — a 404 means the stamped agent is gone.
      const gone =
        slug !== undefined &&
        (await warmPreviewSandbox(target.serverUrl, slug, options.fetchImpl ?? fetch)) === 404;
      if (!(gone || retrySettledFailure)) return;
      if (gone) {
        // The agent is gone but the stamp may say current — the deploy would
        // no-op on the matching hash, so drop the stamp first. `previewSlug`
        // stays: the redeploy re-claims the same slug, so the pane's URL
        // never rots.
        await mutateWorkspace(workspaces, scope, project, (current) => {
          const next = { ...current };
          delete next.previewHash;
          return next;
        });
      }
      options.schedule(scope, project, target);
    })
    .catch(() => undefined);
}

/**
 * The project's preview slug: `<project>-preview`, truncated so the result
 * still fits the platform's 64-char slug shape. Project names are already
 * suffix-randomized server-side, so cross-tenant collisions are as unlikely
 * as for the production slug; a real collision surfaces as the deploy CLI's
 * ownership 409 in `previewError`.
 */
export function previewSlugFor(project: string): string {
  // Suffix shared with the sandbox-tag inference (`roleForSlug`), so preview
  // deploys and the "preview" role in Modal's dashboard can't drift.
  const base = project.slice(0, MAX_SLUG_LENGTH - PREVIEW_SLUG_SUFFIX.length).replace(/[-_]+$/, "");
  return `${base}${PREVIEW_SLUG_SUFFIX}`;
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
    const hash = currentFilesHash(workspace);
    if (workspace.previewHash === hash) return;
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
    await mutateWorkspace(options.workspaces, scope, project, (current) => {
      const next = { ...current };
      if (outcome.ok) {
        next.previewSlug = outcome.slug ?? slug;
        next.previewHash = hash;
        delete next.previewError;
      } else {
        next.previewError = outcome.output.slice(0, MAX_PREVIEW_ERROR);
      }
      return next;
    });
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
    // the second finds `previewHash` current and no-ops.
    await withLock(projectLock, projectKey(scope, project), () =>
      attempt(scope, project, { serverUrl, apiKey }),
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
          ...(target.userId && { userId: target.userId }),
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
