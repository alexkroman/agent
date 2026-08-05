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
 * Publish output is posted into the chat for the coding agent to read and
 * act on, so an unhandled rejection reaches it as a bare 500 with nothing
 * actionable in it. The `console.warn`s keep the real diagnosis in the
 * server log, where monitoring can still see an infrastructure problem for
 * what it is.
 *
 * Split out of studio-session-broker.ts, which owns the sandbox lifecycle;
 * this owns what to do with one once a deploy needs it.
 */

import { errorMessage } from "@alexkroman1/aai";
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
  /** Dead sandbox: drop it so the next broker call respawns. */
  dispose: () => Promise<void>;
};

export type PublisherDeps = {
  spawn: typeof spawnWarmHarness;
  /** Absolute path to the built harness; defaults to the resolved one. */
  harnessPath?: string | undefined;
  /** The project's live sandbox, or null when it has none. */
  liveSession: (scope: string, project: string) => LiveSession | null;
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
      ...(target.slug ? { slug: target.slug } : {}),
      ...(target.allowPreviewSlug ? { allowPreviewSlug: true } : {}),
    },
    WORKSPACE_DEPLOY_TIMEOUT_MS,
  );
  const parsed = WorkspaceDeployResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      output: `Malformed deploy response from sandbox: ${parsed.error.message}`,
    };
  }
  return parsed.data;
}

/**
 * Build the broker's `deployWorkspace`: live sandbox first, else an
 * ephemeral one spawned for this deploy and torn down after (Publish from
 * the editor shouldn't leave a sandbox running that no chat session owns).
 */
export function createWorkspacePublisher(deps: PublisherDeps) {
  return async function deployWorkspace(
    scope: string,
    project: string,
    files: Record<string, string>,
    target: WorkspaceDeployTarget,
  ): Promise<WorkspaceDeployOutcome> {
    const existing = deps.liveSession(scope, project);
    if (existing) {
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
    try {
      warm.conn.listen();
      return await requestDeploy(warm, files, target);
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
    } finally {
      await warm[Symbol.asyncDispose]().catch(() => undefined);
    }
  };
}
