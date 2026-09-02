// Copyright 2026 the AAI authors. MIT license.
/**
 * The GitHub REST client the studio acts through, and the three repository
 * questions the sync asks of it.
 *
 * Octokit rather than hand-rolled `fetch` calls, for the reason this repo
 * reaches for `p-timeout` over a `Promise.race`: the parts that get
 * re-derived wrong are the boring ones. Here that is App JWT minting (RS256,
 * with GitHub's clock-skew tolerance), installation-token exchange and its
 * expiry-aware caching, and the error shape every call site branches on.
 * `@octokit/auth-app` owns all of it; nothing in this package mints a token.
 *
 * **One client per (App, installation), built per request.** Installation
 * tokens live an hour and `createAppAuth` caches them for the life of the
 * instance, so a longer-lived client would be a cache we would then have to
 * invalidate when a user disconnects. A per-request instance costs one token
 * exchange and cannot serve a revoked installation.
 *
 * Every call carries a deadline. Octokit imposes none of its own, and the
 * sync's callers are an HTTP handler and a browser behind it — an unbounded
 * GitHub call is a studio request that never answers.
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import type { GithubAppConfig } from "./studio-github-config.ts";

/** A GitHub client, as the rest of this package sees one. */
export type GithubOctokit = InstanceType<typeof Octokit>;

/** Per-call deadline. Sized for a cold GitHub API call, not for a build. */
const GITHUB_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Pages of `GET /installation/repositories` to walk.
 *
 * A bound rather than "until GitHub stops": this feeds a picker, and an
 * installation with more repositories than this has told us the user does not
 * want to scroll a flat list anyway. 100 per page × 10 = 1,000.
 */
const MAX_REPO_PAGES = 10;
const REPO_PAGE_SIZE = 100;

/**
 * One repository, as the picker shows it.
 *
 * Deliberately NOT carrying a default branch: a sync reads that from the
 * repository at push time (`readRepoDefaultBranch`), because a copy captured
 * when the list was fetched can be a rename out of date — so a field here
 * would be a value nothing may act on.
 */
export type GithubRepoSummary = {
  /** `owner/repo` — the form the workspace stamps and the picker shows. */
  fullName: string;
  private: boolean;
};

/** Who an installation belongs to, as GitHub reports it. */
export type GithubInstallationAccount = {
  account: string;
  accountType: "User" | "Organization";
};

/**
 * A GitHub call that failed with a status we want to act on rather than
 * propagate — `404` on an installation that is gone, `403` on a permission
 * the App was not granted.
 *
 * Read off the error's `status` and never its message: Octokit's
 * `RequestError` carries the number, and matching prose would turn a reworded
 * GitHub error into a silent behaviour change.
 */
export function githubErrorStatus(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;
  return typeof err.status === "number" ? err.status : undefined;
}

/** `fetch` with the module's deadline composed onto the caller's signal. */
function deadlineFetch(base: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const deadline = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
    // Composed, never replaced: `AbortSignal.any` settles on whichever fires
    // first, so Octokit's own signal (and any caller's) can only ever make a
    // request end sooner. Sources are held weakly — no unlink bookkeeping.
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return base(input, { ...init, signal });
  };
}

export type GithubClientOptions = {
  /**
   * Act as this installation. Omitted, the client authenticates as the APP
   * itself (a JWT), which is the only thing that can read
   * `GET /app/installations/{id}` — and which can read no repository at all.
   */
  installationId?: number | undefined;
  /** Test seam — never set outside tests. */
  fetchFn?: typeof globalThis.fetch;
};

export function createGithubOctokit(
  config: GithubAppConfig,
  options: GithubClientOptions = {},
): GithubOctokit {
  const auth = {
    appId: config.appId,
    privateKey: config.privateKey,
    ...omitUndefined({ installationId: options.installationId }),
  };
  return new Octokit({
    authStrategy: createAppAuth,
    auth,
    request: { fetch: deadlineFetch(options.fetchFn ?? globalThis.fetch) },
  });
}

/**
 * Resolve an installation id to the account that holds it, or `null` when
 * GitHub does not know it.
 *
 * This is what makes the install callback trustworthy. `?installation_id=` is
 * a number in a URL the browser was redirected with, and the signed state
 * proves only WHO is asking, never WHAT they are attaching — so the id is
 * resolved against GitHub, as the App, before any record names it. A forged
 * or foreign id 404s here and is never stored.
 */
export async function resolveInstallation(
  config: GithubAppConfig,
  installationId: number,
  // The options carry no `installationId`, structurally: only an APP JWT may
  // read this endpoint, so a client scoped to an installation would 403 on the
  // one call that decides whether that installation is real.
  options: Pick<GithubClientOptions, "fetchFn"> = {},
): Promise<GithubInstallationAccount | null> {
  const octokit = createGithubOctokit(config, options);
  try {
    const { data } = await octokit.request("GET /app/installations/{installation_id}", {
      installation_id: installationId,
    });
    // `account` is nullable in GitHub's schema (an installation on a deleted
    // account), and it is the only thing that names an owner — so a null one
    // is the same answer as an unknown installation: nothing to link.
    const { account } = data;
    if (!(account && "login" in account && account.login)) return null;
    // GitHub types `type` as a broad string; only the two values below decide
    // anything here (whether a repository can be CREATED), so anything else is
    // treated as the account kind with fewer capabilities.
    const isOrg = "type" in account && account.type === "Organization";
    return { account: account.login, accountType: isOrg ? "Organization" : "User" };
  } catch (err) {
    if (githubErrorStatus(err) === 404) return null;
    throw err;
  }
}

/**
 * Every repository the installation can reach, for the picker.
 *
 * The installation's OWN list rather than the user's: those are different
 * sets, and this one is the truthful answer to "where can this sync write".
 * A repository the user owns but did not grant the App is correctly absent —
 * showing it would offer a destination every sync would 404 on.
 */
export async function listInstallationRepos(
  octokit: GithubOctokit,
): Promise<readonly GithubRepoSummary[]> {
  const repos: GithubRepoSummary[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const { data } = await octokit.request("GET /installation/repositories", {
      per_page: REPO_PAGE_SIZE,
      page,
    });
    for (const repo of data.repositories) {
      repos.push({ fullName: repo.full_name, private: repo.private });
    }
    if (data.repositories.length < REPO_PAGE_SIZE) break;
  }
  return repos;
}

/**
 * The repository's default branch — where a sync goes when the caller names
 * no branch.
 *
 * Read at sync time rather than trusted from the client, which is the same
 * rule the rest of this surface follows: the picker's copy was true when the
 * list was fetched, and a repository whose default branch was renamed since
 * would otherwise have a branch silently CREATED under the old name.
 */
export async function readRepoDefaultBranch(
  octokit: GithubOctokit,
  owner: string,
  repo: string,
): Promise<string> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
  // Empty on a repository with no commits: GitHub reports the branch it WILL
  // create, but older/edge shapes leave it blank, and `main` is what the first
  // push then creates anyway.
  return data.default_branch || "main";
}

/**
 * Create a repository under the installation's ORGANIZATION.
 *
 * Organizations only, and that is GitHub's boundary rather than a shortcut:
 * `POST /user/repos` is not available to installation tokens at all, so a
 * personal account's repository cannot be created by an App acting as an
 * installation no matter what permissions it holds. Reaching it would mean
 * carrying user-to-server OAuth tokens and their refresh cycle — a second
 * credential per user, expiring on its own schedule, for one button.
 *
 * The routes therefore treat creation as the secondary path: the user picks a
 * repository they granted the App, and for a personal account creates it on
 * GitHub first. The callers translate this refusal into that instruction.
 */
export async function createOrgRepo(
  octokit: GithubOctokit,
  org: string,
  name: string,
): Promise<GithubRepoSummary> {
  const { data } = await octokit.request("POST /orgs/{org}/repos", {
    org,
    name,
    // Private by default: a studio workspace is somebody's unreleased product,
    // and a public repository is not a thing to make on their behalf.
    private: true,
    auto_init: false,
  });
  return { fullName: data.full_name, private: data.private };
}
