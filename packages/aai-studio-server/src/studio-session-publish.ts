// Copyright 2026 the AAI authors. MIT license.
/**
 * One deploy of a studio workspace — Publish, and the auto preview deploys
 * that ride the same path.
 *
 * The guest runs the LITERAL `aai deploy` CLI (see aai-guest/
 * studio-publish.ts); this module is only the host half: pick a sandbox to
 * run it in, send `workspace/deploy`, and turn whatever comes back — a CLI
 * success, CLI diagnostics, or a sandbox that died — into one
 * {@link WorkspaceDeployOutcome}.
 *
 * **Everything here reports failure as an OUTCOME, never as a throw.**
 * Publish output is the only thing the user sees about a publish — it is
 * rendered by the menu they pressed — so an unhandled rejection reaches
 * them as a bare 500 with nothing actionable in it. The `console.warn`s keep the real diagnosis in the
 * server log, where monitoring can still see an infrastructure problem for
 * what it is.
 *
 * Split out of studio-session-broker.ts, which owns the sandbox lifecycle;
 * this owns what to do with one once a deploy needs it.
 */

import { errorMessage } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { resolveHarnessPath } from "aai-server/constants";
import type { spawnWarmHarness, WarmHarness } from "aai-server/sandbox-vm";
import { z } from "zod";

/** Deadline for one in-guest Publish (`aai deploy`: cold build + upload). */
const WORKSPACE_DEPLOY_TIMEOUT_MS = 330_000;

/**
 * Response of the guest's `workspace/deploy` (guest-asserted wire data):
 * the guest ran the literal `aai deploy` CLI, and `output` is what the
 * chat shows — a success summary or the CLI's failure diagnostics.
 */
const WorkspaceDeployResponseSchema = z.object({
  ok: z.boolean(),
  slug: z.string().optional(),
  url: z.string().optional(),
  output: z.string().max(64_000),
});

export type WorkspaceDeployOutcome = z.infer<typeof WorkspaceDeployResponseSchema>;

/** What Publish hands the guest's CLI: the platform origin + caller key. */
export type WorkspaceDeployTarget = {
  serverUrl: string;
  apiKey: string;
  slug?: string | undefined;
  /**
   * Opt into a `-preview`-suffixed slug at the deploy boundary. Set ONLY by
   * the auto-preview deployer (studio-preview.ts), which targets
   * `<project>-preview` on purpose. Publish shares this path and must leave
   * it unset, or a project named `*-preview` would claim a slug the
   * orphan-preview reaper deletes hourly.
   */
  allowPreviewSlug?: boolean | undefined;
  /**
   * `--skipTypecheck`: forwarded to the in-sandbox `aai deploy` so a Publish
   * can skip the tsc gate the same way `aai deploy --skipTypecheck` does.
   * Absent reads as "run the gate" — the safe default.
   */
  skipTypecheck?: boolean | undefined;
};

/**
 * A project's live coding-agent sandbox, as the publisher needs to see it:
 * somewhere to send the request, a way to mark it used, and a way to drop it
 * when it turns out to be dead. The broker owns the map this comes from.
 */
export type LiveSession = {
  warm: WarmHarness;
  /** Publishing is activity — keep the idle sweeper off a busy session. */
  touch: () => void;
  /**
   * Hold the sandbox against idle eviction for the length of the deploy;
   * call the returned release when it settles (idempotent).
   *
   * `touch` alone cannot cover this, and the two numbers say why:
   * {@link WORKSPACE_DEPLOY_TIMEOUT_MS} is 330s while `STUDIO_SESSION_IDLE_MS`
   * is 300s, and the touch happens only once the request RETURNS — so a cold
   * build that starts more than ~100s into an idle window is swept while it
   * runs, and `disposeEntry` terminates the sandbox the guest's own
   * `aai deploy` is executing in. The measured cost is the whole build again
   * plus a dead chat URL in the browser. A hold is preferred over widening
   * the idle window because it says the true thing — this sandbox is BUSY —
   * instead of guessing how long busy lasts.
   */
  hold: () => () => void;
  /** Dead sandbox: drop it so the next broker call respawns. */
  dispose: () => Promise<void>;
};

/**
 * A per-deploy consequence: what a slug the deploy just claimed owes its
 * project. Named here rather than at the composer (studio-deploy-hooks.ts)
 * because THIS is the seam that takes one — so the two producers can be typed
 * by the contract they satisfy without importing the thing that composes them.
 */
export type AfterDeploy = (scope: string, project: string, slug: string) => Promise<void>;

export type PublisherDeps = {
  spawn: typeof spawnWarmHarness;
  /** Absolute path to the built harness; defaults to the resolved one. */
  harnessPath?: string | undefined;
  /** The project's live sandbox, or null when it has none. */
  liveSession: (scope: string, project: string) => LiveSession | null;
  /**
   * Run after a SUCCESSFUL deploy, with the slug it claimed. Both deploy
   * paths — Publish and the auto preview deploy — go through this one
   * publisher, so a per-deploy consequence wired here cannot be implemented
   * for one and forgotten for the other. The studio uses it to give a newly
   * claimed slug the secrets its project holds (`studio-deploy-hooks.ts`).
   */
  afterDeploy?: AfterDeploy | undefined;
};

/** Send one `workspace/deploy` and validate the guest's response. */
async function requestDeploy(
  warm: WarmHarness,
  files: Record<string, string>,
  target: WorkspaceDeployTarget,
): Promise<WorkspaceDeployOutcome> {
  const raw = await warm.conn.sendRequest(
    "workspace/deploy",
    {
      files,
      serverUrl: target.serverUrl,
      apiKey: target.apiKey,
      ...omitUndefined({ slug: target.slug }),
      ...(target.allowPreviewSlug ? { allowPreviewSlug: true } : {}),
      // Plain key (not a guarded spread): JSON-RPC drops an undefined value on
      // the wire, so an older guest still sees the field absent.
      skipTypecheck: target.skipTypecheck,
    },
    WORKSPACE_DEPLOY_TIMEOUT_MS,
  );
  const parsed = WorkspaceDeployResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      output: `Malformed deploy response from sandbox: ${errorMessage(parsed.error)}`,
    };
  }
  return parsed.data;
}

/**
 * Build the broker's `deployWorkspace`: one deploy (see {@link runDeploy}),
 * then whatever the slug it claimed owes its project ({@link
 * PublisherDeps.afterDeploy}).
 *
 * `afterDeploy` can never fail a deploy. The CLI output is already on its
 * way to the chat, so reporting a transport error over a follow-up would be
 * a lie about what happened.
 */
export function createWorkspacePublisher(deps: PublisherDeps) {
  return async function deployWorkspace(
    scope: string,
    project: string,
    files: Record<string, string>,
    target: WorkspaceDeployTarget,
  ): Promise<WorkspaceDeployOutcome> {
    const outcome = await runDeploy(deps, scope, project, files, target);
    // A failed deploy claimed no slug, so there is nothing to follow up on.
    const slug = outcome.ok ? (outcome.slug ?? target.slug) : undefined;
    if (deps.afterDeploy && slug !== undefined) {
      await deps.afterDeploy(scope, project, slug).catch((err: unknown) => {
        console.warn("Studio publish: post-deploy step failed", {
          project,
          slug,
          error: errorMessage(err),
        });
      });
    }
    return outcome;
  };
}

/**
 * One deploy: live sandbox first, else an ephemeral one spawned for this
 * deploy and torn down after (Publish from the editor shouldn't leave a
 * sandbox running that no chat session owns).
 */
async function runDeploy(
  deps: PublisherDeps,
  scope: string,
  project: string,
  files: Record<string, string>,
  target: WorkspaceDeployTarget,
): Promise<WorkspaceDeployOutcome> {
  const existing = deps.liveSession(scope, project);
  if (existing) {
    // Held for the whole round trip, not touched after it: a build can outlast
    // the idle window (see LiveSession.hold).
    const release = existing.hold();
    try {
      const outcome = await requestDeploy(existing.warm, files, target);
      existing.touch();
      return outcome;
    } catch (err) {
      // Dead sandbox — replace it with a fresh one for this publish;
      // the next chat broker call heals the session itself.
      console.warn("Studio publish: live sandbox failed; using a fresh one", {
        project,
        error: errorMessage(err),
      });
      await existing.dispose();
    } finally {
      release();
    }
  }

  // Neither half below throws — see the module doc. Deliberately not
  // retried either: a build that kills its sandbox usually kills the next
  // one too, and a silent second attempt only doubles the wait before the
  // user learns that.
  let warm: WarmHarness;
  try {
    warm = await deps.spawn({
      harnessPath: deps.harnessPath ?? resolveHarnessPath(),
      slug: project,
      role: "studio-publish",
    });
  } catch (err) {
    console.warn("Studio publish: could not start a sandbox", {
      project,
      error: errorMessage(err),
    });
    return {
      ok: false,
      output:
        `Could not start a build sandbox for Publish (${errorMessage(err)}). ` +
        "Nothing was deployed. Try Publish again in a moment.",
    };
  }
  // `await using` rather than a `finally`: this sandbox is spawned for this
  // one publish and must be torn down on every exit path. Safe to let the
  // declaration own it because `WarmHarness[Symbol.asyncDispose]` cannot
  // reject (warm-harness.ts swallows its own teardown failures — a sandbox
  // that already died is the expected case here), so disposal can never
  // replace this function's return value or suppress the error below.
  await using sandbox = warm;
  try {
    sandbox.conn.listen();
    return await requestDeploy(sandbox, files, target);
  } catch (err) {
    // Died mid-publish — an OOM at the bundler's memory peak is the
    // realistic one (see the burst-range notes in aai-server).
    console.warn("Studio publish: sandbox failed during deploy", {
      project,
      error: errorMessage(err),
    });
    return {
      ok: false,
      output:
        `The build sandbox stopped responding during Publish (${errorMessage(err)}). ` +
        "This usually means the build ran out of memory. Try Publish again; if it " +
        "keeps failing, reduce what the build has to bundle.",
    };
  }
}
