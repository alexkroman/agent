// Copyright 2026 the AAI authors. MIT license.
/**
 * "Sync to GitHub" — the account's GitHub link, and the push itself.
 *
 * - `GET    /studio/github`         — session-authed: is it configured, is
 *   this account connected, and to which GitHub account
 * - `POST   /studio/github/connect` — session-authed: mint the authorize URL
 * - `GET    /studio/github/callback`— **PUBLIC**: GitHub returns the browser
 *   here after the user authorizes; the signed `state` is the only thing
 *   naming a user
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
  type GithubOctokit,
  listInstallationRepos,
  readRepoDefaultBranch,
} from "./studio-github-client.ts";
import {
  type GithubAppConfig,
  githubAuthorizeUrl,
  githubInstallPageUrl,
  githubInstallUrl,
} from "./studio-github-config.ts";
import { type ConnectOutcome, completeGithubConnect } from "./studio-github-connect.ts";
import { deleteGithubLink, type GithubLink, readGithubLink } from "./studio-github-link.ts";
import { signInstallState, verifyInstallState } from "./studio-github-state.ts";
import {
  type GithubSyncResult,
  githubCreateErrorMessage,
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
 * Push, and record where it landed.
 *
 * Split out of the route so each half is one thing: the route decides whether
 * this request may push at all, and this decides what pushing means.
 *
 * The branch is always the repository's OWN default, read here rather than
 * accepted from the caller — the picker's copy can be a rename out of date,
 * and a client-named branch would be a request field no studio control
 * produces (see `GithubSyncSchema`).
 */
async function pushToGithub(opts: {
  octokit: GithubOctokit;
  workspace: StudioWorkspace;
  target: { owner: string; repo: string };
  scope: string;
  project: string;
  workspaces: StudioHonoEnv["Bindings"]["workspaces"];
}): Promise<GithubSyncResult & { ok: true; repo: string; branch: string }> {
  const { octokit, workspace, target, scope, project } = opts;
  // Derived, never carried alongside: this and `target` are one value, and two
  // spellings of it in one signature is a read hazard.
  const repo = `${target.owner}/${target.repo}`;
  const branch = await readRepoDefaultBranch(octokit, target.owner, target.repo);

  // The idempotence token only means anything against the SAME target: the
  // hash describes the FILES, never where they went, so a stamp left by a
  // different repository or branch would report a brand-new destination as
  // already in sync and push nothing to it.
  const sameTarget = workspace.githubRepo === repo && workspace.githubBranch === branch;
  const result = await syncWorkspaceToGithub({
    octokit,
    workspace,
    target: { ...target, branch },
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

  /**
   * The five guards every repository route repeats, in one place: a fresh
   * session, a configured App, a linked installation, one Octokit built from
   * it, and GitHub's failures translated to an actionable sentence.
   *
   * Two callers is usually a reason NOT to abstract; here the shared part is
   * the whole body and the varying part is one expression, so a change to any
   * guard would otherwise have to be made twice — with a silently skipped
   * check as the failure mode.
   */
  const withInstallation = async (
    c: Context<StudioHonoEnv>,
    what: "repo list" | "repo create",
    // A `Response` is returned as-is, anything else is the JSON body. That is
    // what lets a handler answer with its OWN status (the personal-account
    // 409) without routing a non-GitHub refusal through the 502 catch below.
    run: (octokit: GithubOctokit, link: GithubLink) => Promise<unknown>,
  ): Promise<Response> => {
    const user = await requireStudioUser(c.req.raw, c.env);
    if (!config) return notConfigured(c);
    const link = await readGithubLink(c.env.secrets, user.id);
    if (!link) return notConnected(c);
    const octokit = createGithubOctokit(config, {
      installationId: link.installationId,
      ...clientOptions,
    });
    try {
      const answer = await run(octokit, link);
      return answer instanceof Response ? answer : c.json(answer);
    } catch (err) {
      log.warn(`github ${what} failed`, { reason: errorMessage(err) });
      // The two operations read the same statuses differently — a 422 on a
      // create is a taken name, not a branch that moved under a push — so the
      // vocabulary follows the operation rather than the transport.
      const message =
        what === "repo create" ? githubCreateErrorMessage(err) : githubSyncErrorMessage(err);
      return c.json({ error: message }, 502);
    }
  };

  studio.get("/github", async (c) => {
    const user = await requireStudioUser(c.req.raw, c.env);
    if (!config) return c.json({ configured: false, connected: false });
    const link = await readGithubLink(c.env.secrets, user.id);
    return c.json({
      configured: true,
      connected: link !== null,
      // The App's own settings page — where a user adds a repository to the
      // installation, which is the fix for half the errors this flow produces.
      manageUrl: githubInstallPageUrl(config),
      ...omitUndefined({ account: link?.account, accountType: link?.accountType }),
    });
  });

  /**
   * Mint the connect redirect.
   *
   * A POST at CLICK time rather than a URL handed out with the status above,
   * because the state expires (`INSTALL_STATE_TTL_MS`) and a settings pane
   * left open for an hour would otherwise hold a link that fails on arrival —
   * at GitHub, after the user has picked repositories, which is the worst
   * possible moment to discover it.
   *
   * It is the AUTHORIZE url, not the install page: the install page does not
   * redirect back for an App that is already installed, which stranded the
   * whole flow (see `githubAuthorizeUrl`). The response field keeps its name
   * — what the client does with it is unchanged, and renaming it would be a
   * wire break for a distinction the caller does not make.
   */
  studio.post("/github/connect", zValidator("json", GithubConnectSchema), async (c) => {
    const user = await requireStudioUser(c.req.raw, c.env);
    if (!config) return notConfigured(c);
    const state = signInstallState(config, {
      uid: user.id,
      project: c.req.valid("json").project,
    });
    return c.json({ installUrl: githubAuthorizeUrl(config, state) });
  });

  studio.delete("/github", async (c) => {
    const user = await requireStudioUser(c.req.raw, c.env);
    await deleteGithubLink(c.env.secrets, user.id);
    // 200 whether or not a link existed: "not connected" is the state the
    // caller asked for, and reporting 404 for an already-disconnected account
    // would make the button fail exactly when it has nothing to do.
    return c.json({ ok: true });
  });

  studio.get("/github/repos", (c) =>
    withInstallation(c, "repo list", async (octokit) => ({
      repos: await listInstallationRepos(octokit),
    })),
  );

  studio.post("/github/repos", zValidator("json", GithubCreateRepoSchema), (c) =>
    withInstallation(c, "repo create", async (octokit, link) => {
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
      return { repo: await createOrgRepo(octokit, link.account, c.req.valid("json").name) };
    }),
  );

  /**
   * Where GitHub returns the browser after the user authorizes the App.
   *
   * Every exit is a REDIRECT rather than a JSON body: the caller is a
   * navigating browser, and a JSON error page at the end of an OAuth-shaped
   * flow strands the user on a dead URL. All but one carry a `?github=`
   * result the client renders in the pane they started from; the exception
   * sends a user with nothing installed on to GitHub's install page, which is
   * the continuation of this flow rather than the end of it.
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

    let outcome: ConnectOutcome;
    try {
      outcome = await completeGithubConnect({
        config,
        secrets: c.env.secrets,
        uid: claims.uid,
        code: c.req.query("code") ?? "",
        // Absent for everyone who already had the App installed, which is the
        // majority case through the authorize endpoint — so it is resolved
        // from the user token rather than refused.
        rawInstallationId: c.req.query("installation_id"),
        fetchFn,
      });
    } catch (err) {
      log.warn("github install callback failed", { reason: errorMessage(err) });
      return back("failed", claims.project);
    }
    // Authorized us and holds no installation of this App — so the next step is
    // picking repositories, not an error. A fresh state, because the one that
    // got here is minutes into its ten-minute life and the install page is
    // where the user spends the rest of them.
    if (outcome === "install") {
      const state = signInstallState(config, { uid: claims.uid, project: claims.project });
      return c.redirect(githubInstallUrl(config, state));
    }
    return back(outcome, claims.project);
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

    // Independent reads, so one round trip rather than two: the link says
    // whether this account may push at all and the workspace says what there
    // is to push, and neither answer depends on the other. The rare
    // not-connected case fetches a workspace it discards, which is the cheaper
    // half of the trade — the client only offers Sync once `connected`.
    const [link, workspace] = await Promise.all([
      readGithubLink(c.env.secrets, userId),
      getWorkspace(c.env.workspaces, scope, project),
    ]);
    if (!link) return notConnected(c);
    if (!workspace) return projectNotFound(c);

    const target = parseRepoFullName(c.req.valid("json").repo);
    if (!target) return c.json({ error: "Expected owner/repo" }, 400);

    try {
      return c.json(
        await pushToGithub({
          octokit: createGithubOctokit(config, {
            installationId: link.installationId,
            ...clientOptions,
          }),
          workspace,
          target,
          scope,
          project,
          workspaces: c.env.workspaces,
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
