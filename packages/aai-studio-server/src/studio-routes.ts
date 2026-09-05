// Copyright 2025 the AAI authors. MIT license.
/**
 * HTTP surface of the browser studio, mounted at `/studio` — the whole route
 * inventory, whichever module registers it:
 *
 * - `GET  /studio/status`                     — which LLM chat runs on
 * - The project document's own CRUD — list, create, read, delete, the two
 *   file routes, and `aai push`'s `PUT …/source` — lives in
 *   studio-project-routes.ts, which registers it here. Split out when this
 *   file reached the 500-line cap; that module's header lists the eight
 *   routes.
 * - `POST /studio/projects/:project/deploy`   — the project's sandbox runs
 *   `aai deploy`; the CLI output rides back for the chat
 * The project-level `database` routes used to sit here: one switch across both of
 * a project's deployed agents, and a read-only table viewer behind the studio's
 * Database pane. Both are gone with the per-app databases they managed — durable
 * runs, the run journal and session state are the platform's now, reached over
 * HTTP — and so is the `?environment=` validation the viewer needed, which existed
 * because reading the wrong agent's rows is the difference between "my tool saved
 * nothing" and "my tool saved it in the preview".
 *
 * - `GET/PUT/DELETE /studio/projects/:project/secret` — the project's
 *   secrets, written to BOTH deployed agents. The per-slug `/:slug/secret`
 *   routes `aai secret` drives stay the platform primitive underneath; this
 *   is the project-level switch over them, exactly as the database routes
 *   are for `ctx.db`. The fan-out used to live in the browser, which made
 *   "a project is two agents" a property of the studio CLIENT — see
 *   studio-project-slugs.ts.
 * - `POST /studio/projects/:project/session`  — boot the project's coding-agent
 *   sandbox; the browser then streams chat turns DIRECTLY to the sandbox's
 *   public `/studio/chat` (see studio-session-broker.ts)
 * - `POST /studio/projects/:project/preview/wake` — the Preview pane reporting
 *   that the platform does not serve the slug it frames. The second trigger
 *   for `wakeProjectPreview`, and the only one a tab that never re-opens the
 *   project can reach
 *
 * - `GET/POST/DELETE /studio/github*` — the account's GitHub App link and
 *   `POST /studio/projects/:project/github/sync`, the push
 *   (studio-github-routes.ts, which lists the seven). One of them,
 *   `GET /studio/github/callback`, is PUBLIC and is the only route in the
 *   studio that cannot authenticate its caller — GitHub performs that
 *   navigation, so a signed `state` stands in. Named here because this
 *   inventory is where somebody auditing the surface from the top would look
 *   for exactly that.
 * - `GET /studio/events` and `GET /studio/projects/:project/events` — the two
 *   SSE streams (studio-events-routes.ts).
 *
 * Plus the browser-session surface:
 * - `GET /studio/auth`         — public: how to sign in (Supabase/dev/none)
 * - `GET /studio/account`      — session-authed: email + whether a key is stored
 * - `PUT /studio/account/key`  — session-authed: store the AssemblyAI key
 * - `POST /studio/cli-link/approve`  — session-authed: approve an `aai login`
 *   link code, granting that one code a one-shot exchange
 * - `POST /studio/cli-link/exchange` — public: the CLI polls this with its
 *   code; once approved it returns the account's stored API key (one-shot)
 *
 * Auth: the browser sends its Supabase session token, which `authMw`
 * resolves to the user's stored AssemblyAI key (see aai-server middleware);
 * raw API-key bearers (CLI, evals) keep working unchanged. Workspaces are
 * namespaced by `studioScope` over the user id for sessions, over the key
 * for raw callers — either way a caller only ever sees their own projects.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { authMw, userApiKeySecretName } from "aai-server/http";
import { createLogger } from "aai-server/logger";
import { TtlCache } from "aai-server/platform";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { registerAccountRoutes } from "./studio-account-routes.ts";
import {
  projectNotFound,
  requestBrowserOrigin,
  requestPublicOrigin,
  type StudioHonoEnv,
} from "./studio-context.ts";
import { deployStudioProject } from "./studio-deploy.ts";
import { createAfterDeploy } from "./studio-deploy-hooks.ts";
import { registerEventRoutes } from "./studio-events-routes.ts";
import { createGithubAppConfig, type GithubAppConfig } from "./studio-github-config.ts";
import { registerGithubRoutes } from "./studio-github-routes.ts";
import { studioLlmInfo } from "./studio-llm.ts";
import type { PreviewQueue } from "./studio-preview-queue.ts";
import { PREVIEW_WAKE_THROTTLE_MS, wakeProjectPreview } from "./studio-preview-wake.ts";
import { registerProjectRoutes } from "./studio-project-routes.ts";
import type { StudioRateLimiters } from "./studio-rate-limit.ts";
import { createRouteLimits } from "./studio-route-limits.ts";
import { ProjectNameSchema } from "./studio-schemas.ts";
import { registerSecretRoutes } from "./studio-secret-routes.ts";
import { createStudioSessionBroker, type StudioSessionBroker } from "./studio-session-broker.ts";
import type { StudioSessionRegistry } from "./studio-session-registry.ts";
import { onSettledEdit, previewOrigin } from "./studio-settled-edit.ts";
import { projectKey, studioScope } from "./studio-workspace.ts";

const log = createLogger("studio.routes");

export type StudioRouteOptions = {
  /**
   * Rate limiters for chat and project creation. Postgres-backed in
   * production so the limits hold across replicas; defaults to per-process
   * in-memory windows (dev/tests).
   */
  rateLimiters?: StudioRateLimiters | undefined;
  /** Test seam: swap the deploy pipeline without module mocks. */
  deployProject?: typeof deployStudioProject;
  /** Test seam: swap the coding-agent session broker. */
  broker?: (stores: {
    workspaces: StudioHonoEnv["Bindings"]["workspaces"];
    chats: StudioHonoEnv["Bindings"]["chats"];
  }) => StudioSessionBroker;
  /**
   * Cross-replica studio session registry + this replica's identity. Both or
   * neither: the registry's `owner` checks are meaningless without a distinct
   * id. Absent (dev/tests, no platform database) leaves each replica with its
   * own sandbox per project, which is the behaviour this pair replaces.
   */
  sessionRegistry?: StudioSessionRegistry;
  replicaId?: string;
  /**
   * Durable preview-deploy queue (studio-preview-queue.ts): pgmq in production,
   * `createMemoryPreviewQueue()` in a single process. REQUIRED all the way from
   * the composition root — see the note on `StudioSessionBrokerOptions
   * .previewQueue` for the second decision point this replaced.
   */
  previewQueue: PreviewQueue;
  /**
   * The GitHub App backing "Sync to GitHub". Resolved from the environment
   * when omitted, and `undefined` when the platform has none — which disables
   * the feature rather than failing a boot (studio-github-config.ts).
   */
  githubApp?: GithubAppConfig | undefined;
  /** Test seam: drive the GitHub routes against a fake API without module mocks. */
  githubFetch?: typeof globalThis.fetch;
};

function validateProject(name: string | undefined): string {
  const parsed = ProjectNameSchema.safeParse(name);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid project name" });
  return parsed.data;
}

export function createStudioRoutes(options: StudioRouteOptions): {
  routes: Hono<StudioHonoEnv>;
  /**
   * Tear down the broker's per-project sandboxes. A no-op when no session
   * request ever built the lazy broker.
   */
  dispose: () => Promise<void>;
} {
  const deploy = options.deployProject ?? deployStudioProject;
  // One broker per app instance, created lazily on the first session request
  // (the stores ride on the request env). Per-replica, like the slot cache.
  let broker: StudioSessionBroker | undefined;
  const ensureBroker = (c: Context<StudioHonoEnv>): StudioSessionBroker => {
    // Everything below runs ONCE per process, inside the guard rather than
    // ahead of it: `createAfterDeploy` and the `resolveApiKey` closure were
    // built on every call and discarded on all but the first, which is a hook
    // pair allocated per request for a once-per-process construction.
    if (!broker) {
      // Read the stores out of the request env rather than closing over `c`:
      // the broker outlives every request, and a closure over the Context
      // would pin that whole request — its body, headers, and response — for
      // the life of the process.
      const secrets = c.env.secrets;
      broker = (options.broker ?? createStudioSessionBroker)({
        workspaces: c.env.workspaces,
        chats: c.env.chats,
        ...omitUndefined({ registry: options.sessionRegistry, replicaId: options.replicaId }),
        previewQueue: options.previewQueue,
        // Runs after any successful deploy, on both paths — see
        // studio-deploy-hooks.ts.
        afterDeploy: createAfterDeploy(c),
        // A preview job redelivered here may have been enqueued by a replica
        // that is gone, so the drain resolves the user's key from Vault rather
        // than the job carrying one. Bound to the request env's SecretStore —
        // the same `user-key:<uid>` record the bearer resolution reads.
        resolveApiKey: (userId) => secrets.get(userApiKeySecretName(userId)),
      });
    }
    return broker;
  };

  const studio = new Hono<StudioHonoEnv>();

  const limits = createRouteLimits(options.rateLimiters);

  studio.get("/status", (c) => c.json(studioLlmInfo()));

  // /auth, /account, /account/key, /cli-link/* — the browser-session
  // account surface (key onboarding, `aai login` device link).
  registerAccountRoutes(studio);

  // Bearer auth without slug ownership: workspace scoping needs only the
  // deterministic `studioScope`, and the deploy path derives the ownership
  // hash itself.
  studio.use("/projects", authMw);
  studio.use("/projects/*", authMw);
  studio.use("/events", authMw);

  // Workspace scope: browser sessions scope by the studio user (stable
  // across AssemblyAI key rotation), raw-key callers (CLI, evals) by the
  // key itself — the pre-login behavior. The `user:` prefix keeps the two
  // hash inputs from ever colliding.
  const requestScope = (c: Context<StudioHonoEnv>): string =>
    c.var.userId ? studioScope(`user:${c.var.userId}`) : studioScope(c.var.apiKey);

  // Scope + validated project for every `/projects/:project` route, stamped
  // once here (mirroring the agent service's `slugMw`) so a new route can't
  // forget `validateProject` — an unvalidated param would flow into store
  // keys and deploy slugs as an arbitrary path segment.
  const projectMw = async (c: Context<StudioHonoEnv>, next: () => Promise<void>) => {
    c.set("scope", requestScope(c));
    c.set("project", validateProject(c.req.param("project")));
    await next();
  };
  studio.use("/projects/:project", projectMw);
  studio.use("/projects/:project/*", projectMw);

  // The two live event streams (studio-events-routes.ts).
  registerEventRoutes(studio, requestScope);

  /** See studio-settled-edit.ts — what an out-of-turn workspace write owes. */
  const settledEdit = (c: Context<StudioHonoEnv>, scope: string, project: string): void =>
    onSettledEdit(ensureBroker(c), c, scope, project);

  /**
   * The project-preview wake, from either of its two triggers — opening the
   * project, and the pane reporting the page missing. One call site so the
   * two cannot drift on what a wake IS (in particular on `previewOrigin`,
   * whose `userId` is the field a second copy silently loses — see
   * studio-settled-edit.ts).
   */
  const wake = (c: Context<StudioHonoEnv>, scope: string, project: string): void =>
    wakeProjectPreview({
      workspaces: c.env.workspaces,
      scope,
      project,
      target: { ...previewOrigin(c), apiKey: c.var.apiKey },
      schedule: ensureBroker(c).schedulePreview,
    });

  // The project document itself: list/create/read/delete, the two file
  // routes, and `aai push`'s whole-map replace (studio-project-routes.ts).
  registerProjectRoutes(studio, {
    requestScope,
    projectCreate: limits.projectCreate,
    settledEdit,
  });

  studio.post("/projects/:project/deploy", async (c) => {
    const { scope, project } = c.var;
    // Optional, defensive: an older CLI sends no body at all, and Publish has
    // no other body fields, so anything unparsable reads as "run the tsc gate".
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const skipTypecheck = (body as { skipTypecheck?: unknown }).skipTypecheck === true;
    const result = await deploy(
      {
        workspaces: c.env.workspaces,
        // Publish runs `aai deploy` in a guest sandbox via the session
        // broker — reusing the project's live coding-agent sandbox when one
        // exists. The guest's CLI dials back to this platform's public
        // origin; everything server-side (build inspection, ownership,
        // epochs, the env floor) happens on the standard POST /deploy path.
        deployWorkspace: (deployScope, deployProject, files, target) =>
          ensureBroker(c).deployWorkspace(deployScope, deployProject, files, target),
      },
      {
        apiKey: c.var.apiKey,
        scope,
        project,
        // Two origins, because they answer different questions under the local
        // microVM backend: the guest DIALS the first and the Publish menu SHOWS
        // the second. See `requestBrowserOrigin`.
        serverUrl: requestPublicOrigin(c),
        browserUrl: requestBrowserOrigin(c),
        skipTypecheck,
      },
    );
    if (!result.ok) {
      // A failed Publish is the most consequential thing a studio user can do,
      // and this 400 was invisible server-side: `error-handler.ts` logs 5xx
      // only — deliberately, since a 4xx is normally the caller's mistake and
      // logging it is a spam vector — and a route that RETURNS `c.json(…, 400)`
      // never reaches that handler at all. So production showed
      // `POST /studio/projects/<p>/deploy -> 400` with no reason anywhere, on
      // the one path where the reason (the tsc gate, the env floor, an
      // ownership check) is the whole diagnosis. The reason already goes to the
      // client; this is the same string, kept.
      log.warn("deploy refused", { scope, project, reason: result.error });
      return c.json({ error: result.error }, 400);
    }
    return c.json(result);
  });

  // Secrets are a PROJECT switch across both deployed agents (production and
  // preview), and the broker is here so a saved secret redeploys the preview
  // that has to carry it (studio-secrets.ts). A `ctx.db` switch sat beside it
  // until per-app databases went away.
  registerSecretRoutes(studio, ensureBroker);

  // /github/* (the account's GitHub App link) and the project's sync route.
  // Registered here, after `projectMw`, so the sync route inherits the
  // validated project and workspace scope every other project route rides.
  registerGithubRoutes(studio, {
    config: options.githubApp ?? createGithubAppConfig(process.env),
    githubSync: limits.githubSync,
    ...omitUndefined({ fetchFn: options.githubFetch }),
  });

  // Boot (or refresh) the project's coding-agent sandbox and return its
  // public chat URL — the browser talks to the sandbox directly from here
  // on (SSE), mirroring how voice clients connect straight to a deployed
  // agent's /websocket. Rate-limited: each call can spawn a Modal sandbox.
  studio.post("/projects/:project/session", async (c) => {
    const { scope, project } = c.var;
    const limited = await limits.chat(scope, c.req.raw);
    if (limited) return limited;
    // Arms auto preview deploys: the guest's end-of-turn sync makes the
    // broker ship the edited workspace to the preview slug. `userId` rides
    // along because a queued job that does not name a studio user cannot be
    // run by any other replica — see `ensureSession`.
    const preview = previewOrigin(c);
    const session = await ensureBroker(c).ensureSession(scope, project, c.var.apiKey, preview);
    if (!session) return projectNotFound(c);
    // The user just landed on (or re-opened) this project — wake its preview
    // too (fire-and-forget; gates and rationale live in studio-preview.ts).
    wake(c, scope, project);
    // `token` is the guest chat surface's per-session bearer — the browser
    // presents it (never a long-lived credential) on the public tunnel URL.
    return c.json({ url: session.url, token: session.token });
  });

  /**
   * The Preview pane reporting that the platform does not serve the slug it
   * frames (`api.wakePreview`).
   *
   * The recovery it reaches is not new — `wakeProjectPreview` has always
   * cleared the stamp and enqueued a deploy when the broker 404s. What was
   * missing is a way to REACH it from a tab that is already open: the only
   * trigger was the once-per-open session broker call, so a preview swept out
   * from under a tab left that tab probing a slug nothing would ever redeploy
   * (1,061 probes over 50 minutes, in production, ended by the user happening
   * to do something else). The pane can see the 404 the server would have to
   * go looking for, so it says so.
   *
   * The caller is a TRIGGER, not evidence: the wake re-checks with its own
   * broker call and schedules nothing unless that 404s too. So this route
   * cannot be talked into a deploy, which is what lets it be cheap to call —
   * but not free, which is why it is rate-limited like its siblings.
   *
   * 202 either way — the wake is fire-and-forget by construction, so "did it
   * redeploy" is not a question this response could answer, and a project
   * that does not exist is a no-op rather than a 404 (the pane only probes a
   * slug the workspace stamped, so a miss here means a delete raced it).
   */
  const wokenRecently = new TtlCache<true>(PREVIEW_WAKE_THROTTLE_MS, 1000);
  studio.post("/projects/:project/preview/wake", async (c) => {
    const { scope, project } = c.var;
    // METERED, like every other route that can spawn a sandbox. The throttle
    // below used to be the whole answer, and a fixed-size `TtlCache` cannot
    // be: it is an LRU, so a caller cycling more than its 1,000 distinct
    // project names evicts entries faster than the TTL expires them and every
    // request lands as a first one. The limiter is the bound that does not
    // move; the throttle is the cheap per-project one for the honest client.
    const limited = await limits.previewWake(scope, c.req.raw);
    if (limited) return limited;
    const key = projectKey(scope, project);
    // Per process, so a fleet-wide burst is bounded by the replica count
    // rather than by one number — enough, because the pane sends this ONCE
    // per missing preview. The throttle is here for the client that stops
    // being that pane, not for the one that is.
    if (!wokenRecently.get(key)) {
      wokenRecently.set(key, true);
      wake(c, scope, project);
    }
    return c.json({ ok: true }, 202);
  });

  return {
    routes: studio,
    dispose: async () => {
      await broker?.dispose();
    },
  };
}
