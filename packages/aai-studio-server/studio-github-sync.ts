// Copyright 2026 the AAI authors. MIT license.
/**
 * A workspace's file map, as ONE commit on a branch.
 *
 * This is the Git Data API rather than a clone: blobs, then a tree, then a
 * commit, then a ref update. No working tree exists anywhere, nothing is
 * checked out, and the whole push is four request kinds — which is what makes
 * it usable from a stateless HTTP handler that must answer a browser.
 *
 * **The tree is written whole (`base_tree` is deliberately absent).** A
 * studio workspace IS the project — the same complete file map `aai push`
 * replaces atomically (`syncWorkspaceSource`) — so a sync is a replacement,
 * not a patch. Layering onto the existing tree would mean a file deleted in
 * the studio silently survived in the repository forever, which is the one
 * outcome a "sync" must not produce. The cost is that a file added on
 * GitHub's side, in the same branch, is removed by the next sync; that is the
 * honest reading of one-way sync, and it is why the branch is the project's
 * own rather than the repository's default by accident.
 *
 * **Idempotent by the same hash the rest of the studio uses.** The workspace
 * stamps `hash` (`filesHash`) on every write, so a sync compares the current
 * hash against what was stamped at the last successful sync and does nothing
 * when they match. Second click, no edits, no commit — the same shape as the
 * preview deploy's `previewHash` no-op, and for the same reason: a button a
 * user can press twice must not produce two commits of identical content.
 *
 * **An empty repository is the common case, not an edge case.** A user who
 * creates a repository for this has one with no commits, so there is no ref
 * to read a parent from — the first sync creates the ref instead of updating
 * it, and both paths write the same tree.
 */

import { errorMessage } from "@alexkroman1/aai";
import { mapConcurrent } from "@alexkroman1/aai/step";
import { type GithubOctokit, githubErrorStatus } from "./studio-github-client.ts";
import type { StudioWorkspace } from "./studio-workspace.ts";

/**
 * How many blobs to upload at once.
 *
 * Blobs are independent, so this is pure latency: a 40-file workspace is 40
 * round trips serially and 5 batches concurrently. Bounded rather than
 * unbounded because the far end meters secondary rate limits on concurrent
 * mutations, and "upload every file at once" is the shape that trips them.
 */
const BLOB_CONCURRENCY = 8;

/** Git's mode for a non-executable file — every workspace file is one. */
const FILE_MODE = "100644";

export type GithubRepoTarget = {
  owner: string;
  repo: string;
  /** Branch to write. The caller resolves the repository's default. */
  branch: string;
};

/** Where a sync landed, for the workspace stamp and the client's link. */
export type GithubSyncResult = {
  /** False when the workspace was already at `syncedHash` — nothing pushed. */
  changed: boolean;
  commitSha: string;
  /** `https://github.com/<owner>/<repo>/commit/<sha>`, for the UI. */
  commitUrl: string;
  /** `filesHash` of what is now on the branch. */
  syncedHash: string;
};

/**
 * What either half of an `owner/repo` may contain — GitHub's own grammar.
 *
 * Exported because `GithubRepoSchema` (studio-schemas.ts) is built from it.
 * The request schema and the check below are two LAYERS on purpose — the
 * schema never sees a value read back off a workspace stamp — but two layers
 * do not need two copies of the pattern, and the dangerous direction of a
 * drift is a sync interpolating a path segment the schema would have refused.
 */
export const GITHUB_NAME_RE = /^[\w.-]{1,100}$/;

/** Parse `owner/repo`, or null. Both halves become request path segments. */
export function parseRepoFullName(fullName: string): { owner: string; repo: string } | null {
  const [owner, repo, ...rest] = fullName.split("/");
  if (!(owner && repo) || rest.length > 0) return null;
  return GITHUB_NAME_RE.test(owner) && GITHUB_NAME_RE.test(repo) ? { owner, repo } : null;
}

/**
 * The commit `branch` currently points at, or `null` when the branch (or the
 * whole repository) has no commits yet.
 *
 * 404 is the answer for both "no such branch" and "empty repository", and
 * they call for the same thing here — create the ref — so they are not
 * distinguished. 409 is GitHub's specific "Git Repository is empty".
 */
async function readBranchHead(
  octokit: GithubOctokit,
  target: GithubRepoTarget,
): Promise<string | null> {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: target.owner,
      repo: target.repo,
      ref: `heads/${target.branch}`,
    });
    return data.object.sha;
  } catch (err) {
    const status = githubErrorStatus(err);
    if (status === 404 || status === 409) return null;
    throw err;
  }
}

/**
 * Upload every file as a blob and assemble the tree.
 *
 * Content goes up base64-encoded rather than as UTF-8 `content`: a workspace
 * holds whatever the coding agent wrote, and the JSON `utf-8` encoding round
 * trips lone surrogates and NUL bytes differently than the bytes we hold.
 * Base64 is exact for both.
 */
async function writeTree(
  octokit: GithubOctokit,
  target: GithubRepoTarget,
  files: Record<string, string>,
): Promise<string> {
  const entries = Object.entries(files);
  const blobs = await mapConcurrent(entries, BLOB_CONCURRENCY, async ([path, content]) => {
    const { data } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
      owner: target.owner,
      repo: target.repo,
      content: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64",
    });
    return { path, mode: FILE_MODE, type: "blob", sha: data.sha } as const;
  });
  const { data } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner: target.owner,
    repo: target.repo,
    // No `base_tree`: see the module header — a sync REPLACES the tree, so a
    // file deleted in the studio is deleted on the branch.
    tree: [...blobs],
  });
  return data.sha;
}

/** Point `branch` at `commitSha`, creating the ref when it does not exist. */
async function moveBranch(
  octokit: GithubOctokit,
  target: GithubRepoTarget,
  commitSha: string,
  hadHead: boolean,
): Promise<void> {
  if (!hadHead) {
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner: target.owner,
      repo: target.repo,
      ref: `refs/heads/${target.branch}`,
      sha: commitSha,
    });
    return;
  }
  await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner: target.owner,
    repo: target.repo,
    ref: `heads/${target.branch}`,
    sha: commitSha,
    // NOT forced. The commit we just built names the branch head we read as
    // its parent, so a fast-forward is exactly what should succeed — and a
    // non-fast-forward means somebody pushed while we were uploading blobs.
    // Forcing would discard their commit silently; failing surfaces it, and
    // the user's next sync (which re-reads the head) carries the workspace
    // forward on top of theirs.
    force: false,
  });
}

/**
 * The thing the Sync button does.
 *
 * `syncedHash` is what the workspace stamped at the last successful sync to
 * THIS repository and branch; the caller is responsible for not passing one
 * from a different target, since the hash describes the files and not where
 * they went.
 */
export async function syncWorkspaceToGithub(opts: {
  /**
   * The installation client, built by the CALLER.
   *
   * Passed in rather than constructed here, because `createAppAuth` caches
   * the installation token for the life of an Octokit instance — so a second
   * instance is a second token exchange, a real round trip to GitHub. The
   * route resolves the repository's default branch through the same client
   * before calling this, and building one here made every branch-defaulted
   * sync pay for two.
   */
  octokit: GithubOctokit;
  workspace: StudioWorkspace;
  target: GithubRepoTarget;
  /** Project name — the commit message's subject. */
  project: string;
  /** `filesHash` at the last successful sync to this target, if any. */
  syncedHash?: string | undefined;
}): Promise<GithubSyncResult> {
  const { octokit, workspace, target, project } = opts;
  const commitUrlFor = (sha: string): string =>
    `https://github.com/${target.owner}/${target.repo}/commit/${sha}`;

  const head = await readBranchHead(octokit, target);

  // The no-op, checked AFTER reading the head rather than before opening a
  // client: a stamp claiming the branch is current is only believable while
  // the branch still exists, and a repository recreated under the same name
  // is a real thing users do.
  if (head !== null && opts.syncedHash === workspace.hash) {
    return {
      changed: false,
      commitSha: head,
      commitUrl: commitUrlFor(head),
      syncedHash: workspace.hash,
    };
  }

  const treeSha = await writeTree(octokit, target, workspace.files);
  const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner: target.owner,
    repo: target.repo,
    message: `Sync ${project} from AAI Studio`,
    tree: treeSha,
    parents: head ? [head] : [],
  });
  await moveBranch(octokit, target, commit.sha, head !== null);

  return {
    changed: true,
    commitSha: commit.sha,
    commitUrl: commitUrlFor(commit.sha),
    syncedHash: workspace.hash,
  };
}

/**
 * A GitHub failure as a sentence the studio user can act on.
 *
 * The statuses are the three misconfigurations this flow really produces, and
 * each names the fix rather than the symptom: an uninstalled App, a
 * repository the installation was not granted, and a branch somebody pushed
 * to mid-sync. Anything else keeps GitHub's own words — a message we did not
 * anticipate is more useful verbatim than flattened into "sync failed".
 */
export function githubSyncErrorMessage(err: unknown): string {
  return githubErrorMessage(err, "sync");
}

/**
 * The same translation for a repository CREATE, whose statuses mean something
 * different: 422 is "that name is taken" (or otherwise invalid), not a branch
 * that moved. Reusing the sync vocabulary here answered a duplicate name with
 * "That branch moved while the sync was running", which is advice about a
 * different operation entirely.
 */
export function githubCreateErrorMessage(err: unknown): string {
  return githubErrorMessage(err, "create");
}

function githubErrorMessage(err: unknown, kind: "sync" | "create"): string {
  if (kind === "create") {
    switch (githubErrorStatus(err)) {
      case 401:
      case 404:
        return "GitHub no longer grants access to that account — reconnect GitHub.";
      case 403:
        return "The GitHub App is not permitted to create repositories in that organization.";
      case 422:
        return "That repository name is already taken, or is not a name GitHub accepts.";
      default:
        return errorMessage(err);
    }
  }
  return syncErrorMessage(err);
}

function syncErrorMessage(err: unknown): string {
  switch (githubErrorStatus(err)) {
    case 401:
    case 404:
      return "GitHub no longer grants access to that repository — reconnect GitHub, or add the repository to the installation.";
    case 403:
      return "The GitHub App is not permitted to write to that repository. Grant it Contents: read and write.";
    case 409:
    case 422:
      return "That branch moved while the sync was running — try again.";
    default:
      return errorMessage(err);
  }
}
