// Copyright 2026 the AAI authors. MIT license.
/**
 * The "landing on a project" half of previews: warming the agent the pane
 * embeds, and the two cases where the workspace's own stamp cannot correct
 * itself.
 *
 * Split from studio-preview.ts, which owns the deploy LOOP (the durable queue,
 * the per-project lock, the stamps). This is the other side — nothing here
 * deploys anything itself; it decides whether there is something for that loop
 * to do and hands it over through {@link forcePreviewRedeploy}. Splitting them
 * also matches how the suites were already split
 * (`studio-preview.test.ts` vs `studio-preview-deploy.test.ts`) and keeps both
 * modules under the file-length cap.
 */

import type { WorkspaceStore } from "aai-server/stores";
import {
  forcePreviewRedeploy,
  type PreviewDeployer,
  type PreviewTarget,
} from "./studio-preview.ts";
import { getWorkspace } from "./studio-workspace.ts";

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
 * How long one project's wake stays throttled. Sized against what a wake
 * COSTS — a workspace read plus a broker call that can spawn a sandbox — not
 * against how often a healthy client sends one, which is once.
 */
export const PREVIEW_WAKE_THROTTLE_MS = 30_000;

/**
 * Something says the project's preview may need regenerating. Two triggers,
 * both fire-and-forget (the caller's response never waits on it):
 *
 * - **Landing on the project** — the once-per-open session broker call
 *   (`POST /projects/:project/session`), i.e. "the user is looking at this
 *   again".
 * - **The Preview pane reporting the page missing**
 *   (`POST /projects/:project/preview/wake`), which is the same condition
 *   observed from the only place that can see it in a tab that never re-opens
 *   the project. The two are not redundant: the open-signal fires once and
 *   then never again for the life of the tab, so a preview swept an hour later
 *   had nothing to correct it — the pane polled `/:slug/health` 1,061 times
 *   across 50 minutes in production before an unrelated action happened to
 *   broker a session. Neither trigger is TRUSTED; both land here, and the
 *   404 check below is what decides.
 *
 * It always warms the sandbox of the agent the pane embeds (the preview,
 * falling back to the production agent for projects published before previews
 * existed) via {@link warmPreviewSandbox}, so a preview idle-evicted since the
 * last visit is booting before the pane's iframe asks for it.
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
 * no job exists and the workspace stamp cannot correct itself. Both take the
 * same exit — {@link forcePreviewRedeploy}, which clears `previewHash` AND
 * schedules:
 *
 * - **A 404 from the broker** means the platform no longer knows the agent at
 *   all — the deploy behind the workspace's preview stamp is GONE
 *   (expired/swept/deleted out from under it), so "preview is current" is a
 *   lie, and no queued job exists because nothing was edited. Only 404
 *   triggers it: a 503 means a sandbox mid-boot (the broker keeps booting it
 *   and the pane's own fetch retries), and redeploying on that would churn a
 *   healthy slow boot.
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
 *   This branch used to SKIP the stamp clear, which made it a no-op for the
 *   one workspace state it most needed to fix — see `forcePreviewRedeploy`.
 *
 * The `previewError` stamp itself is left in place while the retry runs: only
 * a successful deploy deletes it (`attempt`), so the pane keeps showing the
 * last real error until there is something better to say, rather than
 * flickering to "starting".
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
      // `previewSlug` is deliberately left alone: the redeploy re-claims the
      // same slug, so the pane's URL never rots.
      await forcePreviewRedeploy(workspaces, scope, project, () =>
        options.schedule(scope, project, target),
      );
    })
    .catch(() => undefined);
}
