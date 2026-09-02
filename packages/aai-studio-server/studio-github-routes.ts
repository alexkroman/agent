// Copyright 2026 the AAI authors. MIT license.
/**
 * "Sync to GitHub" — the account's GitHub link, and the push itself.
 *
 * - `GET    /studio/github`         — session-authed: is it configured, is
 *   this account connected, and to which GitHub account
 * - `POST   /studio/github/connect` — session-authed: mint the install URL
 * - `GET    /studio/github/callback`— **PUBLIC**: GitHub returns the browser
 *   here after an install; the signed `state` is the only thing naming a user
 * - `DELETE /studio/github`         — session-authed: forget the link
 * - `GET    /studio/github/repos`   — session-authed: the picker's list
 * - `POST   /studio/github/repos`   — session-authed: create one (orgs only)
 * - `POST   /studio/projects/:project/github/sync` — the button
 *
 * **Two different authentications, and the split is the same one the account
 * routes make.** Everything under `/github` uses `requireStudioUser`, which
 * asks the Auth server itself (`verifyAccessTokenFresh`) — these routes grant
 * and revoke write access to somebody's source code, so a session signed out
 * two minutes ago must not still be able to reconnect a repository. The SYNC
 * route instead rides the ordinary `/projects/*` middleware, which resolves
 * the locally-verified session and the account's stored key: it is the hot
 * path, it grants nothing new, and it is refused outright unless a link an
 * authenticated session already established says so.
 *
 * **The callback is public because it structurally cannot be anything else.**
 * It is a top-level navigation performed by github.com, with no bearer to
 * present. What stands in for authentication is the pair described in
 * studio-github-state.ts and studio-github-client.ts: the `state` is HMAC
 * signed (so `uid` is ours, not the caller's), and the `installation_id` is
 * resolved against GitHub as the App before anything is stored (so the
 * installation is real and we know whose it is).
 */

import { errorMessage } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { zValidator } from "@hono/zod-validator";
import { createLogger } from "aai-server/logger";
import { requireStudioUser } from "aai-server/middleware";
import type { Context, Hono } from "hono";
import { projectNotFound, type StudioHonoEnv } from "./studio-context.ts";
import {
  createGithubOctokit,
  createOrgRepo,
  listInstallationRepos,
  readRepoDefaultBranch,
  resolveInstallation,
} from "./studio-github-client.ts";
import { type GithubAppConfig, githubInstallUrl } from "./studio-github-config.ts";
import {
  deleteGithubLink,
  type GithubLink,
  readGithubLink,
  writeGithubLink,
} from "./studio-github-link.ts";
import { signInstallState, verifyInstallState } from "./studio-github-state.ts";
import {
  type GithubSyncResult,
  githubSyncErrorMessage,
  parseRepoFullName,
  syncWorkspaceToGithub,
} from "./studio-github-sync.ts";
import type { RefuseFn } from "./studio-route-limits.ts";
import { GithubConnectSchema, GithubCreateRepoSchema, GithubSyncSchema } from "./studio-schemas.ts";
import { getWorkspace, type StudioWorkspace, stampWorkspaceMeta } from "./studio-workspace.ts";

const log = createLogger("studio.github");

/**
 * Where the callback sends the browser back to — the studio URL for a project,
 * or the home hero.
 *
 * The client's own `projectPath` (aai-studio-client/src/project-route.ts) is
 * the same mapping from the other side; it is spelled again here rather than
 * imported because this package must not depend on the client bundle's source
 * for a two-line rule, and `ProjectNameSchema` has already constrained the
 * name to the slug grammar, so there is nothing to escape.
 */
function studioProjectPath(project?: string): string {
  return project ? `/studio/chat/${project}` : "/";
}

export type GithubRouteDeps = {
  /** The App, or undefined when the platform has none — see studio-github-config.ts. */
  config?: GithubAppConfig | undefined;
  /** The sync route's rate-limit gate (studio-route-limits.ts). */
  githubSync: RefuseFn;
  /** Test seam — never set outside tests. */
  fetchFn?: typeof globalThis.fetch;
};

/** The one "GitHub is not set up on this platform" answer. */
function notConfigured(c: Context<StudioHonoEnv>): Response {
  return c.json({ error: "GitHub sync is not configured on this server" }, 501);
}

/** The one "this account has not connected GitHub" answer. */
function notConnected(c: Context<StudioHonoEnv>): Response {
  return c.json({ error: "Connect GitHub before syncing" }, 409);
}

/**
 * Resolve the branch, push, and record where it landed.
 *
 * Split out of the route so each half is one thing: the route decides whether
 * this request may push at all, and this decides what pushing means.
 */
async function pushToGithub(opts: {
  config: GithubAppConfig;
  link: GithubLink;
  workspace: StudioWorkspace;
  /** `owner/repo`, as stamped and as the client sent it. */
  repo: string;
  owner: string;
  name: string;
  branch?: string | undefined;
  scope: string;
  project: string;
  workspaces: StudioHonoEnv["Bindings"]["workspaces"];
  fetchFn?: typeof globalThis.fetch;
}): Promise<GithubSyncResult & { ok: true; repo: string; branch: string }> {
  const { config, link, workspace, repo, scope, project } = opts;
  // ONE client for the whole push: `createAppAuth` caches the installation
  // token per instance, so a second instance is a second token exchange.
  const octokit = createGithubOctokit(config, {
    installationId: link.installationId,
    ...omitUndefined({ fetchFn: opts.fetchFn }),
  });
  const branch = opts.branch ?? (await readRepoDefaultBranch(octokit, opts.owner, opts.name));

  // The idempotence token only means anything against the SAME target: the
  // hash describes the FILES, never where they went, so a stamp left by a
  // different repository or branch would report a brand-new destination as
  // already in sync and push nothing to it.
  const sameTarget = workspace.githubRepo === repo && workspace.githubBranch === branch;
  const result = await syncWorkspaceToGithub({
    octokit,
    workspace,
    target: { owner: opts.owner, repo: opts.name, branch },
    project,
    ...omitUndefined({ syncedHash: sameTarget ? workspace.githubHash : undefined }),
  });

  // A metadata STAMP, never a read-modify-write: it carries no files, so it
  // cannot revert an edit that landed while the blobs were uploading.
  await stampWorkspaceMeta(opts.workspaces, scope, project, {
    githubRepo: repo,
    githubBranch: branch,
    githubHash: result.syncedHash,
    githubCommit: result.commitSha,
  });
  return { ok: true, repo, branch, ...result };
}

export function registerGithubRoutes(studio: Hono<StudioHonoEnv>, deps: GithubRouteDeps): void {
  const { config, fetchFn } = deps;
  const clientOptions = omitUndefined({ fetchFn });

  /** This account's link, or null — the read every `/github` route opens with. */
  const linkFor = (c: Context<StudioHonoEnv>, userId: string): Promise<GithubLink | null> =>
    readGithubLink(c.env.secrets, userId);

  studio.get("/github", async (c) => {
    const user = await requireStudioUser(c.req.raw, c.env);
    if (!config) return c.json({ configured: false, connected: false });
    const link = await linkFor(c, user.id);
    return c.json({
      configured: true,
      connected: link !== null,
      // The App's own settings page — where a user adds a repository to the
      // installation, which is the fix for half the errors this flow produces.
      manageUrl: `https://github.com/apps/${config.slug}/installations/new`,
      ...omitUndefined({ account: link?.account, accountType: link?.accountType }),
    });
  });

  /**
   * Mint the install redirect.
   *
   * A POST at CLICK time rather than a URL handed out with the status above,
   * because the state expires (`INSTALL_STATE_TTL_MS`) and a settings pane
   * left open for an hour would otherwise hold a link that fails on arrival —
   * at GitHub, after the user has picked repositories, which is the worst
   * possible moment to discover it.
   */
  studio.post("/github/connect", zValidator("json", GithubConnectSchema), async (c) => {
    const user = await requireStudioUser(c.req.raw, c.env);
    if (!config) return notConfigured(c);
    const state = signInstallState(config, {
      uid: user.id,
      project: c.req.valid("json").project,
    });
    return c.json({ installUrl: githubInstallUrl(config, state) });
  });

  studio.delete("/github", async (c) => {
    const user = await requireStudioUser(c.req.raw, c.env);
    await deleteGithubLink(c.env.secrets, user.id);
    // 200 whether or not a link existed: "not connected" is the state the
    // caller asked for, and reporting 404 for an already-disconnected account
    // would make the button fail exactly when it has nothing to do.
    return c.json({ ok: true });
  });

  studio.get("/github/repos", async (c) => {
    const user = await requireStudioUser(c.req.raw, c.env);
    if (!config) return notConfigured(c);
    const link = await linkFor(c, user.id);
    if (!link) return notConnected(c);
    const octokit = createGithubOctokit(config, {
      installationId: link.installationId,
      ...clientOptions,
    });
    try {
      return c.json({ repos: await listInstallationRepos(octokit) });
    } catch (err) {
      log.warn("github repo list failed", { reason: errorMessage(err) });
      return c.json({ error: githubSyncErrorMessage(err) }, 502);
    }
  });

  studio.post("/github/repos", zValidator("json", GithubCreateRepoSchema), async (c) => {
    const user = await requireStudioUser(c.req.raw, c.env);
    if (!config) return notConfigured(c);
    const link = await linkFor(c, user.id);
    if (!link) return notConnected(c);
    // GitHub's boundary, not ours: `POST /user/repos` is unavailable to an
    // installation token at all, so a personal account's repository has to be
    // created on github.com and then added to the installation. Saying so is
    // the whole value of this branch — the alternative is a 403 the user
    // reads as a bug in the studio.
    if (link.accountType !== "Organization") {
      return c.json(
        {
          error:
            "GitHub only lets an App create repositories inside an organization. " +
            "Create the repository on GitHub, then add it to the AAI installation.",
        },
        409,
      );
    }
    const octokit = createGithubOctokit(config, {
      installationId: link.installationId,
      ...clientOptions,
    });
    try {
      return c.json({ repo: await createOrgRepo(octokit, link.account, c.req.valid("json").name) });
    } catch (err) {
      log.warn("github repo create failed", { reason: errorMessage(err) });
      return c.json({ error: githubSyncErrorMessage(err) }, 502);
    }
  });

  /**
   * Where GitHub returns the browser after an install or a reconfiguration.
   *
   * Every exit is a REDIRECT carrying a `?github=` result rather than a JSON
   * body: the caller is a navigating browser, and a JSON error page at the end
   * of an OAuth-shaped flow strands the user on a dead URL. The client reads
   * the parameter and renders the outcome in the pane they started from.
   */
  studio.get("/github/callback", async (c) => {
    const back = (result: string, project?: string): Response =>
      // Relative, deliberately: this lands on the origin the browser already
      // reached, so no scheme or host is derived from request headers — the
      // rule `public-origin.ts` exists for, applied by not needing it.
      c.redirect(`${studioProjectPath(project)}?github=${result}`);

    if (!config) return back("unconfigured");
    const claims = verifyInstallState(config, c.req.query("state") ?? "");
    // One answer for a forged, tampered, or expired state: the user's recovery
    // is identical (start the connect flow again), and distinguishing them
    // tells a prober which half of a forgery they got right.
    if (!claims) return back("expired");

    const installationId = Number(c.req.query("installation_id"));
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      return back("failed", claims.project);
    }
    try {
      // The second check: the id is a number in a URL until GitHub confirms
      // it exists and names its owner. Nothing is stored before this returns.
      const account = await resolveInstallation(config, installationId, clientOptions);
      if (!account) return back("failed", claims.project);
      await writeGithubLink(c.env.secrets, claims.uid, {
        installationId,
        account: account.account,
        accountType: account.accountType,
        connectedAt: Date.now(),
      });
    } catch (err) {
      log.warn("github install callback failed", { reason: errorMessage(err) });
      return back("failed", claims.project);
    }
    return back("connected", claims.project);
  });

  /**
   * The button.
   *
   * Registered on `/projects/:project/*`, so `projectMw` has already stamped
   * the validated project and the caller's workspace scope, and `authMw` has
   * resolved the bearer. The body is {@link pushToGithub} — extracted because
   * the guards in front of it (configured, session-authed, metered, linked,
   * well-formed target, project exists) are one decision each and the push
   * itself is another; together they were a single function nobody could hold
   * in their head, which the lint threshold is there to say.
   */
  studio.post("/projects/:project/github/sync", zValidator("json", GithubSyncSchema), async (c) => {
    const { scope, project } = c.var;
    if (!config) return notConfigured(c);
    // A raw-key caller (the CLI, evals) resolves to no studio user unless an
    // account has claimed the key, and the link is keyed by user id — so there
    // is nobody to read a GitHub authorization for. Deliberately NOT widened to
    // the workspace scope: a key no account claimed must not inherit a browser
    // session's repository write access.
    const userId = c.var.userId;
    if (!userId) {
      return c.json({ error: "Sync to GitHub from the studio in your browser" }, 409);
    }
    const limited = await deps.githubSync(scope, c.req.raw);
    if (limited) return limited;

    const link = await readGithubLink(c.env.secrets, userId);
    if (!link) return notConnected(c);

    const body = c.req.valid("json");
    const target = parseRepoFullName(body.repo);
    if (!target) return c.json({ error: "Expected owner/repo" }, 400);

    const workspace = await getWorkspace(c.env.workspaces, scope, project);
    if (!workspace) return projectNotFound(c);

    try {
      return c.json(
        await pushToGithub({
          config,
          link,
          workspace,
          repo: body.repo,
          owner: target.owner,
          name: target.repo,
          scope,
          project,
          workspaces: c.env.workspaces,
          ...omitUndefined({ branch: body.branch, fetchFn }),
        }),
      );
    } catch (err) {
      // Logged, because a route that RETURNS a non-2xx never reaches
      // error-handler.ts — the same hole the deploy route's warn covers.
      log.warn("github sync failed", { scope, project, reason: errorMessage(err) });
      return c.json({ error: githubSyncErrorMessage(err) }, 502);
    }
  });
}
