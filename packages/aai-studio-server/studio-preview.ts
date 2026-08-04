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
 * Scheduling is fire-and-forget and coalescing: one deploy runs per project
 * at a time, edits landing mid-deploy set a dirty bit, and the loop re-reads
 * the workspace until it is clean — so a burst of tool-call edits costs one
 * (or two) deploys, not one each. A no-op schedule (workspace already at
 * `previewHash`) never deploys at all.
 *
 * Outcomes are stamped on the workspace like Publish's metadata: success
 * writes `previewSlug`/`previewHash` (what tells the client a new preview is
 * up), failure writes `previewError` for the Preview pane's banner — an
 * auto-deploy has no chat turn to carry its CLI output.
 */

import { errorMessage } from "@alexkroman1/aai";
import { MAX_SLUG_LENGTH } from "@alexkroman1/aai/utils";
import { PREVIEW_SLUG_SUFFIX } from "aai-server/sandbox-role";
import type { WorkspaceStore } from "aai-server/workspace-store";
import type { StudioSessionBroker } from "./studio-session-broker.ts";
import {
  currentFilesHash,
  getWorkspace,
  hasPreviewChanges,
  mutateWorkspace,
  projectKey,
} from "./studio-workspace.ts";

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
 * opened instead. Purely an accelerator: failures are swallowed, because
 * the iframe's own fetch remains the functional path.
 */
export function warmPreviewSandbox(
  serverUrl: string,
  slug: string,
  fetchImpl: typeof fetch = fetch,
): void {
  let url: URL;
  try {
    url = new URL(`/${encodeURIComponent(slug)}/client-config`, serverUrl);
  } catch {
    return;
  }
  void fetchImpl(url, { signal: AbortSignal.timeout(PREVIEW_WARM_TIMEOUT_MS) }).catch(
    () => undefined,
  );
}

/**
 * Landing on a project wakes its preview. Hung off the once-per-open
 * session broker call (`POST /projects/:project/session`) — the "user is
 * looking at this project again" signal. Two halves, both fire-and-forget
 * (the caller's response never waits on either):
 *
 * - A STALE preview redeploys via `schedule`. Auto preview deploys are
 *   fire-and-forget with in-process coalescing, so a replica restart (or a
 *   sandbox dying mid-deploy) can drop one — leaving the pane on "Updating
 *   preview…" with nothing actually on the way until the next edit.
 *   Skipped when the last attempt FAILED (`previewError`): that build is
 *   deterministic, the banner already carries its CLI output, and the next
 *   edit reschedules. Also skipped for an EMPTY workspace (a fresh
 *   project): there is nothing deployable, and the first agent turn's
 *   end-of-turn sync owns the first preview.
 * - The sandbox of the agent the pane embeds — the preview, falling back
 *   to the production agent for projects published before previews existed
 *   — is warmed via {@link warmPreviewSandbox}, so a preview idle-evicted
 *   since the last visit is booting before the pane's iframe asks for it.
 */
export function wakeProjectPreview(options: {
  workspaces: WorkspaceStore;
  scope: string;
  project: string;
  target: PreviewTarget;
  /** The broker's `schedulePreview` — called when the preview is stale. */
  schedule: PreviewDeployer["schedule"];
  fetchImpl?: typeof fetch;
}): void {
  const { workspaces, scope, project, target } = options;
  void getWorkspace(workspaces, scope, project)
    .then((workspace) => {
      if (!workspace) return;
      const deployable = Object.keys(workspace.files).length > 0;
      if (deployable && hasPreviewChanges(workspace) && !workspace.previewError) {
        options.schedule(scope, project, target);
      }
      const slug = workspace.previewSlug ?? workspace.deployedSlug;
      if (slug) warmPreviewSandbox(target.serverUrl, slug, options.fetchImpl ?? fetch);
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
};

export type PreviewDeployer = {
  /**
   * Fire-and-forget: deploy the project's current workspace to its preview
   * slug, unless the preview is already current. Calls while a deploy is in
   * flight coalesce into one trailing re-deploy.
   */
  schedule(scope: string, project: string, target: PreviewTarget): void;
};

export type PreviewDeployerOptions = {
  workspaces: WorkspaceStore;
  /** The broker's `deployWorkspace` — the in-sandbox `aai deploy` run. */
  deployWorkspace: StudioSessionBroker["deployWorkspace"];
};

export function createPreviewDeployer(options: PreviewDeployerOptions): PreviewDeployer {
  type Entry = { dirty: boolean; target: PreviewTarget };
  const inflight = new Map<string, Entry>();

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
    });
    // Stamp only the preview metadata (mirrors the Publish stamp in
    // studio-deploy.ts): the deploy takes seconds, and writing the
    // pre-deploy files back would revert anything edited meanwhile. `hash`
    // is of the snapshot that was deployed, so mid-deploy edits still read
    // as preview-stale — and the dirty bit re-deploys them right after.
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

  return {
    schedule(scope, project, target) {
      const key = projectKey(scope, project);
      const existing = inflight.get(key);
      if (existing) {
        existing.dirty = true;
        existing.target = target;
        return;
      }
      const entry: Entry = { dirty: false, target };
      inflight.set(key, entry);
      void (async () => {
        try {
          do {
            entry.dirty = false;
            await attempt(scope, project, entry.target);
          } while (entry.dirty);
        } catch (err) {
          // Transport-level failure (dead sandbox mid-deploy). The next edit
          // reschedules; auto-deploys must never take down the caller.
          console.warn("Studio preview deploy errored", {
            project,
            error: errorMessage(err),
          });
        } finally {
          inflight.delete(key);
        }
      })();
    },
  };
}
