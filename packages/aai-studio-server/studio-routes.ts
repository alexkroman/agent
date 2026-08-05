// Copyright 2025 the AAI authors. MIT license.
/**
 * HTTP surface of the browser studio, mounted at `/studio`:
 *
 * - `GET  /studio/status`                     — is the chat LLM configured?
 * - `GET  /studio/projects`                   — list the caller's projects
 * - `POST /studio/projects`                   — create a project (starter files;
 *   the server generates the name from the creating `prompt` unless an
 *   explicit `name` is sent)
 * - `GET  /studio/projects/:project`          — files + deployed slug
 * - `GET  /studio/projects/:project/chat`     — persisted chat history
 * - `DELETE /studio/projects/:project`        — delete THE PROJECT: workspace,
 *   chat, and its deployed + preview agents (ownership-gated cascade)
 * - `PUT  /studio/projects/:project/file`     — write one file
 * - `DELETE /studio/projects/:project/file`   — delete one file (`?path=`)
 * - `PUT  /studio/projects/:project/source`   — replace the whole file map
 *   (`aai push`; upserts, fast-forward-checked against `baseHash`)
 * - `POST /studio/projects/:project/deploy`   — the project's sandbox runs
 *   `aai deploy`; the CLI output rides back for the chat
 *
 * Storage (per-app database) is deliberately NOT exposed here: enabling it
 * is a CLI action (`aai storage enable`), and deployed-agent secrets are
 * managed by the client against the platform's own `/:slug/secret` routes.
 * - `POST /studio/projects/:project/session`  — boot the project's coding-agent
 *   sandbox; the browser then streams chat turns DIRECTLY to the sandbox's
 *   public `/studio/chat` (see studio-session-broker.ts)
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

import { errorMessage } from "@alexkroman1/aai";
import { zValidator } from "@hono/zod-validator";
import { deleteAgentResources } from "aai-server/delete";
import { authMw } from "aai-server/middleware";
import { resolvePublicOrigin } from "aai-server/public-origin";
import { RESERVED_SLUGS } from "aai-server/schemas";
import { verifySlugOwner } from "aai-server/secrets";
import { generatedSlug } from "aai-server/slug-generate";
import { userApiKeySecretName } from "aai-server/supabase-auth";
import { WorkspaceConflictError } from "aai-server/workspace-store";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { registerAccountRoutes } from "./studio-account-routes.ts";
import type { StudioHonoEnv } from "./studio-context.ts";
import { deployStudioProject } from "./studio-deploy.ts";
import { studioLlmInfo } from "./studio-llm.ts";
import { wakeProjectPreview } from "./studio-preview.ts";
import type { PreviewQueue } from "./studio-preview-queue.ts";
import type { StudioRateLimiters } from "./studio-rate-limit.ts";
import { createRouteLimits } from "./studio-route-limits.ts";
import {
  CreateProjectSchema,
  ProjectNameSchema,
  projectBaseFromPrompt,
  StudioFileSchema,
  SyncSourceSchema,
} from "./studio-schemas.ts";
import { createStudioSessionBroker, type StudioSessionBroker } from "./studio-session-broker.ts";
import type { StudioSessionRegistry } from "./studio-session-registry.ts";
import { createSsePusher, projectPayload } from "./studio-sse.ts";
import { starterFiles } from "./studio-template.ts";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listProjects,
  mutateWorkspace,
  studioScope,
  syncWorkspaceSource,
} from "./studio-workspace.ts";

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
   * Durable preview-deploy queue (studio-preview-queue.ts). Injected in
   * production (pgmq); the broker's in-memory default covers dev and tests.
   */
  previewQueue?: PreviewQueue;
};

/**
 * The public platform origin the guest's `aai deploy` must dial — the
 * browser-facing origin, not this service's own. See `resolvePublicOrigin`
 * for the resolution order and for why the request URL's own scheme is
 * never trusted (it is always cleartext behind Modal, and publishing
 * `http://` cost every Publish its Authorization header on the redirect).
 */
export function requestPublicOrigin(
  c: Context<StudioHonoEnv>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolvePublicOrigin(c.req.raw, env);
}

/** Server-generated project name: prompt-derived base + random suffix. */
function nameFromPrompt(prompt: string | undefined): string {
  return generatedSlug(prompt ? projectBaseFromPrompt(prompt) : undefined);
}

function validateProject(name: string | undefined): string {
  const parsed = ProjectNameSchema.safeParse(name);
  if (!parsed.success) throw new HTTPException(400, { message: "Invalid project name" });
  return parsed.data;
}

export function createStudioRoutes(options: StudioRouteOptions = {}): {
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
    // Read the store out of the request env rather than closing over `c`: the
    // broker outlives every request, and a closure over the Context would pin
    // that whole request — its body, headers, and response — for the life of
    // the process. The workspace/chat bindings below are read eagerly for the
    // same reason.
    const secrets = c.env.secrets;
    broker ??= (options.broker ?? createStudioSessionBroker)({
      workspaces: c.env.workspaces,
      chats: c.env.chats,
      ...(options.sessionRegistry && { registry: options.sessionRegistry }),
      ...(options.replicaId && { replicaId: options.replicaId }),
      ...(options.previewQueue && { previewQueue: options.previewQueue }),
      // A preview job redelivered here may have been enqueued by a replica
      // that is gone, so the drain resolves the user's key from Vault rather
      // than the job carrying one. Bound to the request env's SecretStore —
      // the same `user-key:<uid>` record the bearer resolution reads.
      resolveApiKey: (userId) => secrets.get(userApiKeySecretName(userId)),
    });
    return broker;
  };

  const studio = new Hono<StudioHonoEnv>();

  const limits = createRouteLimits(options.rateLimiters);

  // `llm: true` is legacy shape — chat always runs now, on the caller's key.
  studio.get("/status", (c) => c.json({ llm: true, ...studioLlmInfo() }));

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

  studio.get("/projects", async (c) => {
    const scope = requestScope(c);
    return c.json({ projects: await listProjects(c.env.workspaces, scope) });
  });

  // Live project LIST for the caller's scope — fed by scope-level workspace
  // change events, so a project created or deleted on another device shows
  // up in the home sidebar without a refresh. Own top-level path (never
  // `/projects/events`) because "events" is a valid project name.
  studio.get("/events", (c) => {
    const scope = requestScope(c);
    return streamSSE(c, async (stream) => {
      const sse = createSsePusher(stream);
      const list = async (): Promise<string> =>
        JSON.stringify(await listProjects(c.env.workspaces, scope));
      await sse.write("projects", await list());
      const unwatch = c.env.events.watchScopeProjects(scope, () =>
        sse.push(async () => ({ event: "projects", data: await list() })),
      );
      await sse.wait(unwatch);
    });
  });

  studio.post("/projects", zValidator("json", CreateProjectSchema), async (c) => {
    const scope = requestScope(c);
    const limited = await limits.projectCreate(scope);
    if (limited) return limited;
    const { name, prompt } = c.req.valid("json");
    // No explicit name: the server generates one, v0-style — a readable base
    // from the creating prompt plus a random suffix, via the same generator
    // slugless CLI deploys use (see aai-server/slug-generate.ts). The suffix
    // makes a same-scope collision negligible; one retry absorbs it anyway.
    const attempts = name ? [name] : [nameFromPrompt(prompt), nameFromPrompt(prompt)];
    // Creation is atomic at the store (versioned insert): two concurrent
    // creates — even on different replicas — cannot both succeed, so the
    // loser can never reset the winner's files. No lock needed here.
    for (const candidate of attempts) {
      try {
        const workspace = await createWorkspace(c.env.workspaces, scope, candidate, {
          files: starterFiles(),
        });
        return c.json({ name: candidate, files: workspace.files }, 201);
      } catch (err) {
        if (!(err instanceof WorkspaceConflictError)) throw err;
      }
    }
    return c.json({ error: "Project already exists" }, 409);
  });

  studio.get("/projects/:project", async (c) => {
    const { scope, project } = c.var;
    const workspace = await getWorkspace(c.env.workspaces, scope, project);
    if (!workspace) return c.json({ error: "Project not found" }, 404);
    return c.json(projectPayload(workspace));
  });

  // Live project state: an SSE stream fed by the workspace and chat rows'
  // change streams (Supabase Realtime in production — see
  // platform-events.ts). This replaced the client's preview polling loop.
  // Events are signals: each one re-reads its row, so the pushed payload is
  // always current, never a possibly-truncated wire payload. The first
  // event is the current state, so a subscriber can't miss an edit that
  // landed between its GET and the subscription. `chat` frames carry the
  // settled conversation (the guest's end-of-turn persist), so other
  // tabs/devices see finished turns without re-opening the project.
  studio.get("/projects/:project/events", async (c) => {
    const { scope, project } = c.var;
    const workspace = await getWorkspace(c.env.workspaces, scope, project);
    if (!workspace) return c.json({ error: "Project not found" }, 404);
    return streamSSE(c, async (stream) => {
      const sse = createSsePusher(stream);
      await sse.write("project", JSON.stringify(projectPayload(workspace)));
      const unwatchWorkspace = c.env.events.watchWorkspace(scope, project, () =>
        sse.push(async () => {
          const current = await getWorkspace(c.env.workspaces, scope, project);
          // A vanished workspace (project deleted) ends the stream; the
          // client's other queries surface the 404.
          if (!current) return null;
          return { event: "project", data: JSON.stringify(projectPayload(current)) };
        }),
      );
      const unwatchChat = c.env.events.watchChat(scope, project, () =>
        sse.push(async () => {
          const messages = await c.env.chats.getChat(scope, project);
          return { event: "chat", data: JSON.stringify(messages ?? []) };
        }),
      );
      await sse.wait(() => {
        unwatchWorkspace();
        unwatchChat();
      });
    });
  });

  // Persisted chat history for the project — written server-side when a chat
  // turn's stream settles, restored by the client on project open.
  studio.get("/projects/:project/chat", async (c) => {
    const { scope, project } = c.var;
    // Independent reads — the chat fetch doesn't depend on the existence check.
    const [workspace, messages] = await Promise.all([
      getWorkspace(c.env.workspaces, scope, project),
      c.env.chats.getChat(scope, project),
    ]);
    if (!workspace) return c.json({ error: "Project not found" }, 404);
    return c.json({ messages: messages ?? [] });
  });

  // Deleting a project deletes THE PROJECT — workspace, chat, and its
  // deployed agents (production and preview), the same resources Publish
  // and the preview auto-deploy created. One delete concept on every
  // surface: the studio's Delete button and `aai delete` both land here.
  studio.delete("/projects/:project", async (c) => {
    const { scope, project } = c.var;
    const workspace = await getWorkspace(c.env.workspaces, scope, project);
    const slugs = [
      ...new Set(
        [workspace?.deployedSlug, workspace?.previewSlug].filter(
          (slug): slug is string => typeof slug === "string",
        ),
      ),
    ];
    for (const slug of slugs) {
      // Ownership is still the agents row's credential hash, never project
      // scope alone — a workspace naming a slug the caller doesn't own
      // (however it got there) must not become a deletion oracle.
      const owner = await verifySlugOwner(c.var.apiKey, { slug, store: c.env.store });
      if (owner.status === "owned") await deleteAgentResources(c.env, slug);
    }
    // No lock needed: a racing versioned write cannot resurrect the project —
    // `mutateWorkspace` only ever replaces an existing row.
    await Promise.all([
      deleteWorkspace(c.env.workspaces, scope, project),
      c.env.chats.deleteChat(scope, project),
    ]);
    return c.json({ ok: true });
  });

  // A manual edit is a settled edit — schedule an auto preview deploy, same
  // as the coding agent's end-of-turn sync (fire-and-forget, coalesced).
  const schedulePreview = (c: Context<StudioHonoEnv>, scope: string, project: string): void => {
    ensureBroker(c).schedulePreview(scope, project, {
      serverUrl: requestPublicOrigin(c),
      apiKey: c.var.apiKey,
      // Present for browser sessions only. It is what lets the queued job
      // outlive this replica: the row names the user, and the drain resolves
      // the key from Vault instead of the row carrying a credential.
      ...(c.var.userId && { userId: c.var.userId }),
    });
  };

  studio.put("/projects/:project/file", zValidator("json", StudioFileSchema), async (c) => {
    const { scope, project } = c.var;
    const { path, content } = c.req.valid("json");
    // An editor PUT racing a chat turn drops neither edit: mutateWorkspace
    // serializes local writers and re-derives cleanly on a cross-replica
    // version conflict.
    try {
      const workspace = await mutateWorkspace(c.env.workspaces, scope, project, (current) => ({
        ...current,
        files: { ...current.files, [path]: content },
      }));
      if (!workspace) return c.json({ error: "Project not found" }, 404);
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 400);
    }
    schedulePreview(c, scope, project);
    return c.json({ ok: true });
  });

  studio.delete("/projects/:project/file", async (c) => {
    const { scope, project } = c.var;
    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path query parameter" }, 400);
    let deleted = false;
    const workspace = await mutateWorkspace(c.env.workspaces, scope, project, (current) => {
      // Reset per attempt: a conflict retry re-derives from a fresh read.
      deleted = false;
      if (!current.files[path]) return null;
      deleted = true;
      const files = { ...current.files };
      delete files[path];
      return { ...current, files };
    });
    if (!(workspace && deleted)) return c.json({ error: "File not found" }, 404);
    schedulePreview(c, scope, project);
    return c.json({ ok: true });
  });

  // `aai push`: replace the project's entire file map in one atomic write.
  // Upserts — a first push creates the project under the pushed name (so it
  // shares the create rate limit); later pushes are fast-forward-checked
  // against `baseHash` (409 = the studio edited since the caller's pull).
  // Per-file paths, count, and byte caps are enforced by the workspace
  // write itself, exactly as for the guest's sync and the editor PUT.
  /** Guards a push may trip, as responses: conflict (409) or bad input (400). */
  const syncSourceError = (err: unknown): Response => {
    if (err instanceof WorkspaceConflictError) {
      return Response.json(
        {
          error:
            "Project changed since your last pull — run `aai pull` again (or push with --force)",
        },
        { status: 409 },
      );
    }
    return Response.json({ error: errorMessage(err) }, { status: 400 });
  };

  studio.put("/projects/:project/source", zValidator("json", SyncSourceSchema), async (c) => {
    const { scope, project } = c.var;
    const { files, baseHash } = c.req.valid("json");
    const existing = await getWorkspace(c.env.workspaces, scope, project);
    if (!existing) {
      // Creation via push: same guards as POST /projects — reserved names
      // can never go live, and creates are rate-limited per scope.
      if (RESERVED_SLUGS.has(project)) return c.json({ error: "That name is reserved" }, 400);
      const limited = await limits.projectCreate(scope);
      if (limited) return limited;
    }
    try {
      const result = await syncWorkspaceSource(c.env.workspaces, scope, project, files, baseHash);
      if (result.changed) schedulePreview(c, scope, project);
      return c.json(
        { ok: true, sourceHash: result.sourceHash, created: result.created },
        result.created ? 201 : 200,
      );
    } catch (err) {
      return syncSourceError(err);
    }
  });

  studio.post("/projects/:project/deploy", async (c) => {
    const { scope, project } = c.var;
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
      { apiKey: c.var.apiKey, scope, project, serverUrl: requestPublicOrigin(c) },
    );
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result);
  });

  // Boot (or refresh) the project's coding-agent sandbox and return its
  // public chat URL — the browser talks to the sandbox directly from here
  // on (SSE), mirroring how voice clients connect straight to a deployed
  // agent's /websocket. Rate-limited: each call can spawn a Modal sandbox.
  studio.post("/projects/:project/session", async (c) => {
    const { scope, project } = c.var;
    const limited = await limits.chat(scope);
    if (limited) return limited;
    // The public origin arms auto preview deploys: the guest's end-of-turn
    // sync makes the broker ship the edited workspace to the preview slug.
    const session = await ensureBroker(c).ensureSession(
      scope,
      project,
      c.var.apiKey,
      requestPublicOrigin(c),
    );
    if (!session) return c.json({ error: "Project not found" }, 404);
    // The user just landed on (or re-opened) this project — wake its preview
    // too (fire-and-forget; gates and rationale live in studio-preview.ts).
    wakeProjectPreview({
      workspaces: c.env.workspaces,
      scope,
      project,
      target: { serverUrl: requestPublicOrigin(c), apiKey: c.var.apiKey },
      schedule: ensureBroker(c).schedulePreview,
    });
    // `token` is the guest chat surface's per-session bearer — the browser
    // presents it (never a long-lived credential) on the public tunnel URL.
    return c.json({ url: session.url, token: session.token });
  });

  return {
    routes: studio,
    dispose: async () => {
      await broker?.dispose();
    },
  };
}
