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
 * **A head that moved is rebuilt onto, never reported as advice.** The ref
 * update is not forced, so a push that lands while the blobs are uploading
 * makes it a non-fast-forward; the sync then re-reads the head and builds the
 * same tree onto their commit, up to `REF_CONFLICT_RETRIES` times. That is
 * what the user's own "try again" used to do by hand, and doing it by hand
 * loses again on a branch that is genuinely busy — which is how a message
 * about a race became the standing answer to failures no retry could clear.
 *
 * **An empty repository is the common case, not an edge case.** A user who
 * creates a repository for this has one with no commits, so there is no ref
 * to read a parent from — the first sync creates the ref instead of updating
 * it, and both paths write the same tree.
 *
 * **And on that repository the Git Data API is CLOSED.** Reading the missing
 * ref is not the only thing an empty repository answers differently: GitHub
 * refuses `POST /git/blobs` outright with 409 `Git Repository is empty.`, so
 * the ref-creating path above could never be reached — the very first blob
 * failed, and the user's whole reward for creating a repository for this was
 * a link to the create-a-blob reference page. There is one endpoint that DOES
 * write to a repository with no commits, the Contents API, so a sync that
 * meets that refusal makes the repository non-empty with a single-file commit
 * through it and writes its tree onto that (`initializeRepo`). The tree is
 * still written whole, so that first file is replaced by the sync's own
 * commit a moment later like every other path here.
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

/**
 * How many times to rebuild the commit onto a head that moved under us.
 *
 * A sync cannot name its parent until the blobs are up, so a push landing in
 * that window makes the ref update a non-fast-forward. The old behaviour was
 * to tell the user to press Sync again — which is exactly this loop, run by
 * hand, and which loses again whenever the branch is busy. The tree is
 * already written and content-addressed, so an attempt costs one ref read,
 * one commit and one ref update. Bounded rather than unbounded so a branch
 * under constant push still terminates with a sentence instead of hanging.
 */
const REF_CONFLICT_RETRIES = 2;

export type GithubRepoTarget = {
  owner: string;
  repo: string;
  /** Branch to write. The caller resolves the repository's default. */
  branch: string;
};

/**
 * The branch really is moving under us — raised only after
 * `REF_CONFLICT_RETRIES` rebuilds, and the ONE failure "try again" is honest
 * advice for.
 *
 * A distinct error rather than a status, because the status alone cannot say
 * it: a 422 from `POST /git/trees` is an unacceptable tree, a 422 from
 * `POST /git/refs` can be a name GitHub refuses, and a 422 from the ref
 * update is a race. Answering all three with "that branch moved — try again"
 * is what left a user pressing Sync against failures no retry could clear.
 */
export class GithubRefConflictError extends Error {
  constructor(branch: string) {
    super(`The GitHub branch ${branch} moved while the sync was running`);
    this.name = "GithubRefConflictError";
  }
}

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
 * Whether a failure is GitHub refusing the Git Data API on a repository that
 * has no commits at all.
 *
 * Status alone, which is the same reading `readBranchHead` already takes: on
 * this surface 409 is `Git Repository is empty.` and nothing else. Matching
 * the sentence instead would put the fix at the mercy of GitHub's wording,
 * and the cost of being wrong is bounded — a repository that is NOT empty
 * refuses the bootstrap below rather than gaining a stray commit, because the
 * Contents API will not create a file that already exists.
 */
function isEmptyRepoRefusal(err: unknown): boolean {
  return githubErrorStatus(err) === 409;
}

/**
 * Give a repository with no commits its first one, through the one endpoint
 * that works there.
 *
 * `PUT /repos/{owner}/{repo}/contents/{path}` is the whole reason this
 * function exists: it creates the initial commit on a repository the Git Data
 * API will not touch. It writes a REAL workspace file rather than a
 * placeholder, so the repository's first commit is content the user
 * recognises and nothing has to be deleted afterwards.
 *
 * No `branch`: on an empty repository GitHub only accepts a commit to the
 * default branch, and naming a branch it is about to create is how that call
 * gets refused. When the sync's target IS that branch — what the routes
 * always pass — the caller re-reads the head and commits onto this one; when
 * it is not, the repository is merely no longer empty and the normal
 * create-the-ref path runs unchanged.
 */
async function initializeRepo(
  octokit: GithubOctokit,
  target: GithubRepoTarget,
  project: string,
  files: Record<string, string>,
): Promise<void> {
  // Sorted, so a retried sync writes the same first commit rather than
  // whichever key the file map happened to yield first. `.gitkeep` covers the
  // workspace with no files at all, which has no first file to offer.
  const [path = ".gitkeep", content = ""] =
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b))[0] ?? [];
  await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
    owner: target.owner,
    repo: target.repo,
    path,
    message: `Initialize ${project} from AAI Studio`,
    content: Buffer.from(content, "utf8").toString("base64"),
  });
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

/**
 * Whether the ref moved, and the failure when it did not.
 *
 * The error is carried rather than thrown because the caller has to DECIDE
 * what it meant: the same 422 is a lost race on a busy branch (retry) or a
 * ref GitHub will never accept (surface it), and only a second look at the
 * branch tells the two apart.
 */
type RefMove = { moved: true } | { moved: false; err: unknown };

/**
 * Point `branch` at `commitSha`, creating the ref when it does not exist.
 *
 * A 409 or a 422 from either path is reported rather than thrown, because
 * both paths have the same race: `POST` loses to another create with
 * "Reference already exists", `PATCH` loses to another push with "Update is
 * not a fast forward". Every other status is this module's own failure and
 * propagates.
 */
async function moveBranch(
  octokit: GithubOctokit,
  target: GithubRepoTarget,
  commitSha: string,
  hadHead: boolean,
): Promise<RefMove> {
  try {
    if (!hadHead) {
      await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner: target.owner,
        repo: target.repo,
        ref: `refs/heads/${target.branch}`,
        sha: commitSha,
      });
      return { moved: true };
    }
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: target.owner,
      repo: target.repo,
      ref: `heads/${target.branch}`,
      sha: commitSha,
      // NOT forced. The commit we just built names the branch head we read as
      // its parent, so a fast-forward is exactly what should succeed — and a
      // non-fast-forward means somebody pushed while we were uploading blobs.
      // Forcing would discard their commit silently; rebuilding on top of
      // theirs (see `syncWorkspaceToGithub`) keeps both.
      force: false,
    });
    return { moved: true };
  } catch (err) {
    const status = githubErrorStatus(err);
    if (status === 409 || status === 422) return { moved: false, err };
    throw err;
  }
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

  let head = await readBranchHead(octokit, target);

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

  // Written ONCE, outside the retry below: a tree is content-addressed, so a
  // head that moved changes which commit we build and never which tree it
  // carries. Re-uploading the blobs per attempt would make a busy branch
  // quadratically expensive for no different result.
  //
  // The one thing that is retried here is the refusal a repository with NO
  // COMMITS gives every Git Data write (see the module header). Reactive
  // rather than predicted, because the ref read cannot tell an empty
  // repository from a branch that does not exist yet — it answers 404 for
  // both — while this failure says exactly which one it met. Re-uploading the
  // blobs after the bootstrap costs nothing twice: a blob is content-
  // addressed, so the ones that did land are re-created as themselves.
  let treeSha: string;
  try {
    treeSha = await writeTree(octokit, target, workspace.files);
  } catch (err) {
    if (!isEmptyRepoRefusal(err)) throw err;
    await initializeRepo(octokit, target, project, workspace.files);
    // The bootstrap commit is the parent this sync now builds on — when it
    // landed on the branch we are targeting, which is every sync the routes
    // issue. When it did not, this reads null again and the create-the-ref
    // path below runs exactly as it did before.
    head = await readBranchHead(octokit, target);
    treeSha = await writeTree(octokit, target, workspace.files);
  }

  let parent = head;
  for (let attempt = 0; attempt <= REF_CONFLICT_RETRIES; attempt += 1) {
    const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner: target.owner,
      repo: target.repo,
      message: `Sync ${project} from AAI Studio`,
      tree: treeSha,
      parents: parent ? [parent] : [],
    });
    const move = await moveBranch(octokit, target, commit.sha, parent !== null);
    if (move.moved) {
      return {
        changed: true,
        commitSha: commit.sha,
        commitUrl: commitUrlFor(commit.sha),
        syncedHash: workspace.hash,
      };
    }

    // What the branch points at NOW is the parent the next commit needs.
    const next = await readBranchHead(octokit, target);

    // The one shape that is NOT a race: a create refused while the ref still
    // does not exist lost to nobody — GitHub is rejecting the ref itself, and
    // a second create is the same request with the same answer. Surfacing
    // GitHub's own words is the whole point, because the retry advice this
    // module used to give was a loop the user could not break.
    if (parent === null && next === null) throw move.err;
    parent = next;
  }
  throw new GithubRefConflictError(target.branch);
}

/**
 * A GitHub failure as a sentence the studio user can act on.
 *
 * The cases are the misconfigurations this flow really produces, and each
 * names the fix rather than the symptom: an uninstalled App, a repository the
 * installation was not granted, and a branch somebody pushed to mid-sync.
 * Anything else keeps GitHub's own words — a message we did not anticipate is
 * more useful verbatim than flattened into "sync failed".
 *
 * **Only a message that names an ACTION may be substituted for GitHub's.**
 * "Try again" answered every 409 and 422 here, so a tree GitHub would never
 * accept read as a race, and the advice was a loop: the user pressed Sync,
 * got the same sentence, and had nothing to act on. A retryable conflict is
 * now retried in `syncWorkspaceToGithub` and reaches this function only as
 * `GithubRefConflictError`, so the sentence is true wherever it appears.
 */
export function githubSyncErrorMessage(err: unknown): string {
  // Checked before the status, and it carries none: this is the sync's own
  // verdict after retrying, not a response GitHub sent.
  if (err instanceof GithubRefConflictError) {
    return "That branch moved while the sync was running — try again.";
  }
  switch (githubErrorStatus(err)) {
    case 401:
    case 404:
      return "GitHub no longer grants access to that repository — reconnect GitHub, or add the repository to the installation.";
    case 403:
      return "The GitHub App is not permitted to write to that repository. Grant it Contents: read and write.";
    // 409 and 422 are deliberately absent. A conflict that a retry could clear
    // has already been retried and arrives above; anything still carrying one
    // of those statuses is a request GitHub refuses on its merits (a tree it
    // will not accept, a ref name it will not create), and telling that user
    // to try again is advice that cannot ever work.
    default:
      return errorMessage(err);
  }
}

/**
 * The same translation for a repository CREATE, whose statuses mean something
 * different: 422 is "that name is taken" (or otherwise invalid), not a branch
 * that moved. Reusing the sync vocabulary here answered a duplicate name with
 * "That branch moved while the sync was running", which is advice about a
 * different operation entirely.
 */
export function githubCreateErrorMessage(err: unknown): string {
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
